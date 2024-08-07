import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/store/food', Middleware, async (req, res) => {
        const { food_name, food_amount } = req.body;

        const config_game_items = CONFIG.GET('game_items');

        const food = config_game_items.items[food_name];

        if (typeof food_name !== 'string' || !food || typeof food_amount !== 'number' || food_amount < 1 || food_amount > 1000) {
            return res.status(400).json({ message: 'Bad request.' });
        };

        const { tele_user } = req as RequestWithUser;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            return res.status(429).json({ message: 'Too many requests.' });
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');
        const logCollection = db.collection('logs');

        const session = client.startSession({ causalConsistency: true, defaultTransactionOptions: { retryWrites: true } });

        try {
            session.startTransaction();

            const user = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, balances: 1 }, session });

            if (user === null) {
                return res.status(404).json({ message: 'Not found.' });
            };

            const tgp_balance = (user.balances?.tgp || 0);

            const tgpet_balance = (user.balances?.tgpet || 0);

            const total_balance = tgp_balance + tgpet_balance;

            const total_cost = food.cost * food_amount;

            if (total_balance < total_cost) {
                return res.status(404).json({ message: 'Not found.', status: 'MONEY_ENOUGH_MONEY' });
            };

            let $USER_FILTER, $USER_UPDATE, $LOG_INSERT, $RESPONSE;

            if (tgp_balance >= total_cost) {
                $USER_FILTER = { 'balances.tgp': { $gte: total_cost } };

                $USER_UPDATE = { $inc: { 'balances.tgp': -total_cost, 'totals.tgp_spent': total_cost, 'totals.tgp_spent_food': total_cost } };

                $LOG_INSERT = { tgp_cost: total_cost };

                $RESPONSE = { tgp_cost: total_cost };
            } else {
                const tgpet_cost = total_cost - tgp_balance;

                $USER_FILTER = { 'balances.tgp': { $gte: tgp_balance }, 'balances.tgpet': { $gte: tgpet_cost } };

                $USER_UPDATE = { $inc: { 'balances.tgp': -tgp_balance, 'balances.tgpet': -tgpet_cost, 'totals.tgp_spent': tgp_balance, 'totals.tgp_spent_food': tgp_balance, 'totals.tgpet_spent': tgpet_cost, 'totals.tgpet_spent_food': tgpet_cost } };

                $LOG_INSERT = { tgp_cost: tgp_balance, tgpet_cost };

                $RESPONSE = { tgp_cost: tgp_balance, tgpet_cost };
            };

            const [update_user_result, insert_log_result] = await Promise.all([
                userCollection.updateOne({ tele_id: tele_user.tele_id, ...$USER_FILTER }, { ...$USER_UPDATE, $inc: { ...$USER_UPDATE.$inc, 'totals.spent': total_cost, 'totals.spent_food': total_cost, [`inventorys.${food_name}`]: food_amount } }, { session }),
                logCollection.insertOne({ log_type: 'store/food', tele_id: tele_user.tele_id, food_name, food_amount, total_cost, tgp_balance, tgpet_balance, total_balance, created_at: new Date(), ...$LOG_INSERT }, { session })
            ]);

            if (
                update_user_result.modifiedCount > 0 &&
                insert_log_result.acknowledged === true
            ) {
                await session.commitTransaction();

                return res.status(200).json($RESPONSE);
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