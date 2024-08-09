import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/onchain/repay', Middleware, async (req, res) => {
        const { amount } = req.body;

        if (
            typeof amount !== 'number' || isNaN(amount) || amount < 0 || amount > 5000000000
        ) {
            return res.status(401).json({ message: 'Bad request.' });
        };

        const { tele_user } = req as RequestWithUser;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            return res.status(429).json({ message: 'Too many requests.' });
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');
        const todoCollection = db.collection('todos');

        const session = client.startSession({ causalConsistency: true, defaultTransactionOptions: { retryWrites: true } });

        try {
            session.startTransaction();

            const get_repay = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, is_repaying: 1, "balances.tgpet": 1, ton_mortgage_amount: 1, tgpet_borrowed_amount: 1 }, session });

            if (get_repay === null || get_repay.is_repaying === true) {
                return res.status(404).json({ message: 'You are repaying.' });
            };

            const created_at = new Date();

            if (get_repay.balances.tgpet < amount) {
                return res.status(404).json({ message: 'You do not have enough TGPET.' });
            };

            if (get_repay.tgpet_borrowed_amount < amount) {
                return res.status(404).json({ message: 'You do not have enough borrowed TGPET.' });
            };

            const conversion_value = get_repay.ton_mortgage_amount / get_repay.tgpet_borrowed_amount;

            const repay_ton_amount = amount / conversion_value;

            const onchain_amount = repay_ton_amount.toFixed(9);

            const [add_todo_result, update_user_result] = await Promise.all([
                todoCollection.updateOne(
                    { todo_type: 'onchain/repay', tele_id: tele_user.tele_id, status: 'pending' },
                    {
                        $setOnInsert: {
                            todo_type: 'onchain/repay',
                            tele_id: tele_user.tele_id,
                            status: 'pending',
                            amount: amount,
                            repay_ton_amount,
                            onchain_amount,
                            created_at,
                        },
                    },
                    { upsert: true, session },
                ),
                userCollection.updateOne(
                    {
                        tele_id: tele_user.tele_id,
                        "balances.tgpet": { $gte: amount },
                        ton_mortgage_amount: { $gte: repay_ton_amount },
                        tgpet_borrowed_amount: { $gte: amount },
                    },
                    {
                        $set: { is_repaying: true },
                        $inc: {
                            "balances.tgpet": -amount,
                            ton_mortgage_amount: -repay_ton_amount,
                            tgpet_borrowed_amount: -amount,
                            "totals.tgpet_repayed_amount": amount,
                        },
                    },
                    { session },
                ),
            ]);

            if (add_todo_result.acknowledged === true && add_todo_result.upsertedCount > 0 &&
                update_user_result.acknowledged === true && update_user_result.modifiedCount > 0) {
                await session.commitTransaction();

                return res.status(200).json({ repay_ton_amount, created_at });
            };
        } catch (error) {
            await session.abortTransaction();
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };

        return res.status(500).json({ message: 'Internal server error.' });
    });
}
