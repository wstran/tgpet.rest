import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/store/food', Middleware, async (req, res) => {
        const { food_name, food_amount, token } = req.body;

        const config_store = CONFIG.GET('store');

        const food = config_store.items[food_name];

        if (typeof food_name !== 'string' || typeof food_amount !== 'number' || food_amount < 1 || food_amount > 1000 || !food || (/* token !== 'tgp' &&  */token !== 'tgpet')) {
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
        const logCollection = db.collection('logs');

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
                    { projection: { [`balances.${token}`]: 1 }, session }
                );

                if (!user) {
                    res.status(404).json({ message: 'User not found.' });
                    throw new Error('Transaction aborted: User not found.');
                };

                const balance = user.balances?.[token] || 0;
                const total_cost = food.cost * food_amount;

                if (balance < total_cost) {
                    res.status(400).json({ message: 'Not enough money to purchase food.', status: 'NOT_ENOUGH_MONEY' });
                    throw new Error('Transaction aborted: Not enough money.');
                };

                const [update_user_result, insert_log_result] = await Promise.all([
                    userCollection.updateOne(
                        { tele_id: tele_user.tele_id, [`balances.${token}`]: { $gte: total_cost } },
                        { $inc: { [`balances.${token}`]: -total_cost, 'totals.spent': total_cost, 'totals.spent_food': total_cost, [`totals.${token}_spent`]: total_cost, [`totals.${token}_spent_food`]: total_cost, [`inventorys.${food_name}`]: food_amount } },
                        { session }
                    ),
                    logCollection.insertOne(
                        { log_type: 'store/food', tele_id: tele_user.tele_id, food_name, food_amount, token, total_cost, created_at: new Date() },
                        { session }
                    )
                ]);

                if (update_user_result.modifiedCount > 0 && insert_log_result.acknowledged === true) {
                    res.status(200).json({ [`${token}_cost`]: total_cost });
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
        }
    });
}