import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/self/start', Middleware, async (req, res) => {
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
                const user = await userCollection.findOne(
                    { tele_id: tele_user.tele_id },
                    { projection: { _id: 0, referral_code: 1 }, session },
                );

                if (!user) {
                    res.status(404).json({ message: 'User not found.' });
                    throw new Error('Transaction aborted: User not found.');
                };

                const now_date = new Date();

                const [update_user_result, add_todo_result] = await Promise.all([
                    userCollection.updateOne(
                        { tele_id: tele_user.tele_id },
                        { $set: { started_at: now_date } },
                        { session },
                    ),
                    user.referral_code && todoCollection.insertOne(
                        {
                            todo_type: 'rest:add/user/invite',
                            referral_code: user.referral_code,
                            tele_id: tele_user.tele_id,
                            created_at: now_date,
                            status: "pending",
                        },
                        { session },
                    ),
                ]);

                if (update_user_result.modifiedCount > 0 && (!add_todo_result || add_todo_result.acknowledged === true)) {
                    res.status(200).json({ started_at: now_date });
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