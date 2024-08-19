import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/onchain/convert', Middleware, async (req, res) => {
        const { amount, convert_type } = req.body;

        const convert_sets = CONFIG.GET('convert_sets');

        if (
            typeof amount !== 'number' || isNaN(amount) || amount < 0 || amount === Infinity ||
            typeof convert_type !== 'string' || !convert_sets[convert_type]
            || convert_type !== 'tgp_to_tgpet' // is only 'tgp_to_tgpet'
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
                const user = await userCollection.findOne(
                    { tele_id: tele_user.tele_id },
                    { projection: { _id: 0, [`balances.${convert_sets[convert_type].from}`]: 1 }, session }
                );

                if (user == null) {
                    res.status(404).json({ message: 'User not found.' });
                    throw new Error('Transaction aborted: User not found.');
                };

                if (user.balances[convert_sets[convert_type].from] < amount) {
                    res.status(400).json({ message: 'Insufficient balance.' });
                    throw new Error('Transaction aborted: Insufficient balance.');
                };

                const created_at = new Date();

                const [add_todo_result, update_user_result] = await Promise.all([
                    todoCollection.insertOne(
                        {
                            todo_type: 'onchain/convert',
                            tele_id: tele_user.tele_id,
                            status: 'pending',
                            convert_type,
                            amount,
                            created_at,
                            // ...(convert_type === 'tgpet_to_tgp' ? { status: 'completed', completed_at: created_at } : {})
                        },
                        { session }
                    ),
                    userCollection.updateOne(
                        { tele_id: tele_user.tele_id, [`balances.${convert_sets[convert_type].from}`]: { $gte: amount } },
                        {
                            $inc: {
                                [`balances.${convert_sets[convert_type].from}`]: -amount,
                                // ...(convert_type === 'tgpet_to_tgp' ? { [`balances.${convert_sets[convert_type].to}`]: amount } : {})
                            }
                        },
                        { session }
                    ),
                ]);

                if (add_todo_result.acknowledged === true && update_user_result.modifiedCount > 0) {
                    res.status(200).json({ convert_id: add_todo_result.insertedId, created_at });
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