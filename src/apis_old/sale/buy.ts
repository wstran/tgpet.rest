import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const REDIS_KEY = 'LOTTEFI_API';

export default function (router: Router) {
    router.post("/sale/buy", Middleware, async (req, res) => {
        const { invoice_id } = req.body;

        const now_time = Date.now();

        const is_sale_time = now_time > Date.parse('2024-06-25T08:00:00Z') && now_time < Date.parse('2024-06-29T08:00:00Z');

        if (!is_sale_time || typeof invoice_id !== 'string' || invoice_id.length !== 17) {
            res.status(400).json({ message: 'Bad request.' });
            return;
        };

        const tele_user = (req as RequestWithUser).tele_user;

        if (await redisWrapper.has(REDIS_KEY, tele_user.tele_id)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15);

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection("users");
        const todoCollection = db.collection("todos");

        const session = client.startSession();

        try {
            session.startTransaction({ willRetryWrite: true });

            const get_saled_balance_at = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, saled_balance_at: 1, is_selling: 1 }, session });

            if (get_saled_balance_at !== null) {
                if (get_saled_balance_at.is_selling === true) {
                    res.status(404).json({ message: 'Your request is under consideration' });
                    return;
                };

                const created_at = new Date();

                const estimate_at = new Date(created_at.getTime() + (1000 * 60 * 5));

                const add_todo_result = await todoCollection.updateOne(
                    { todo_type: 'sale_balance', tele_id: tele_user.tele_id, status: 'pending' },
                    {
                        $setOnInsert: {
                            todo_type: 'sale_balance',
                            tele_id: tele_user.tele_id,
                            invoice_id: invoice_id,
                            status: 'pending',
                            estimate_at,
                            created_at,
                        },
                    },
                    { upsert: true, session },
                );

                const is_uppserted = add_todo_result.acknowledged === true && add_todo_result.upsertedCount > 0;

                if (is_uppserted) {
                    const update_state_result = await userCollection.updateOne(
                        { tele_id: tele_user.tele_id },
                        {
                            $set: { is_selling: true, sale_estimate_at: estimate_at },
                        },
                        { session },
                    );

                    const is_updated = update_state_result.acknowledged === true && update_state_result.modifiedCount > 0;

                    if (is_updated) {
                        await session.commitTransaction();

                        res.status(200).json({ message: `Your request is being confirmed` });
                    } else {
                        await session.abortTransaction();
                    };
                } else {
                    await session.abortTransaction();

                    res.status(404).json({ message: 'Your request is under consideration' });
                };

                return;
            };

            throw Error("Query is not acknowledged");
        } catch (error) {
            console.error(error);
            await session.abortTransaction();
            res.status(500).json({ message: 'Internal server error' });
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
};