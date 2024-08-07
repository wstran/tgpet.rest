import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/onchain/borrow', Middleware, async (req, res) => {
        const { amount, invoice_id } = req.body;

        if (
            typeof amount !== 'number' || isNaN(amount) || amount < 0 || amount > 50
            || typeof invoice_id !== 'string' || invoice_id.length !== 17
        ) {
            res.status(401).json({ message: 'Bad request.' });
            return;
        };

        const tele_user = (req as RequestWithUser).tele_user;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');
        const petCollection = db.collection('pets');
        const todoCollection = db.collection('todos');
        const logCollection = db.collection('logs');

        const session = client.startSession({ causalConsistency: true, defaultTransactionOptions: { retryWrites: true } });

        try {
            session.startTransaction();

            const get_borrow = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, is_borrowing: 1 }, session });

            if (get_borrow !== null) {
                if (get_borrow.is_borrowing === true) {
                    res.status(404).json({ message: 'You are borrowing.' });
                    return;
                };

                const created_at = new Date();

                const estimate_at = new Date(created_at.getTime() + (1000 * 60 * 5));

                const add_todo_result = await todoCollection.updateOne(
                    { todo_type: 'onchain/borrow', tele_id: tele_user.tele_id, status: 'pending' },
                    {
                        $setOnInsert: {
                            todo_type: 'borrow_balance',
                            tele_id: tele_user.tele_id,
                            invoice_id: invoice_id,
                            status: 'pending',
                            amount: amount,
                            estimate_at,
                            created_at,
                        },
                    },
                    { upsert: true, session },
                );

                const is_uppserted = add_todo_result.acknowledged === true && add_todo_result.upsertedCount > 0;

                if (is_uppserted) {
                   // todo
                };
            };
        } catch (error) {
            await session.abortTransaction();
            res.status(500).json({ message: 'Internal server error.' });
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}