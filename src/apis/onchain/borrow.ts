import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { generateRandomNumber } from '../../libs/custom';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/onchain/borrow', Middleware, async (req, res) => {
        const { amount } = req.body;

        if (
            typeof amount !== 'number' || isNaN(amount) || amount <= 0 || amount > 5000000000
        ) {
            res.status(400).json({ message: 'Bad request.' });
            return;
        };

        const { tele_user } = req as RequestWithUser;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');
        const todoCollection = db.collection('todos');

        const session = client.startSession({ 
            defaultTransactionOptions: { 
                readConcern: { level: 'local' }, 
                writeConcern: { w: 1 }, 
                retryWrites: false 
            } 
        });

        try {
            await session.withTransaction(async () => {
                const get_borrow = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { is_borrowing: 1 }, session });

                if (get_borrow?.is_borrowing) {
                    res.status(400).json({ message: 'You are already borrowing.' });
                    throw new Error('Transaction aborted: User is already borrowing.');
                };

                const created_at = new Date();
                const estimate_at = new Date(created_at.getTime() + (1000 * 60 * 5));
                const invoice_id = 'B' + generateRandomNumber(16);
                const onchain_amount = (amount * 1000000000).toString();

                const [add_todo_result, update_user_result] = await Promise.all([
                    todoCollection.updateOne(
                        { todo_type: 'onchain/borrow', tele_id: tele_user.tele_id, status: 'pending' },
                        {
                            $setOnInsert: {
                                todo_type: 'onchain/borrow',
                                tele_id: tele_user.tele_id,
                                invoice_id: invoice_id,
                                status: 'pending',
                                amount: amount,
                                onchain_amount: onchain_amount,
                                estimate_at,
                                created_at,
                            },
                        },
                        { upsert: true, session },
                    ),
                    userCollection.updateOne(
                        { tele_id: tele_user.tele_id },
                        { $set: { is_borrowing: true, borrow_estimate_at: estimate_at } },
                        { session },
                    ),
                ]);

                if (add_todo_result.upsertedCount > 0 && update_user_result.modifiedCount > 0) {
                    res.status(200).json({ invoice_id, onchain_amount });
                } else {
                    res.status(500).json({ message: 'Transaction failed to commit.' });
                    throw new Error('Transaction failed to commit.');
                };
            });
        } catch (error) {
            if (!res.headersSent) {
                console.error(error);
                res.status(500).json({ message: 'Internal server error.' });
            };
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}