import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/store/pet', Middleware, async (req, res) => {
        const { pet_name, pet_level } = req.body;

        const config_game_pets = CONFIG.GET('game_pets');
        
        const pet = config_game_pets.pets[pet_name];

        if (typeof pet_name !== 'string' || typeof pet_level !== 'number' || pet_level < 1 || pet_level > 50) {
            res.status(400).json({ message: 'Bad request. Invalid pet name or level.' });
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
        const petCollection = db.collection('pets');
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
                    { projection: { balances: 1 }, session }
                );

                if (!user) {
                    res.status(404).json({ message: 'User not found.' });
                    throw new Error('Transaction aborted: User not found.');
                };

                const tgp_balance = user.balances?.tgp || 0;
                const tgpet_balance = user.balances?.tgpet || 0;
                const total_balance = tgp_balance + tgpet_balance;
                const total_cost = CONFIG.GET('farm_data')[`cost_level_${pet_level}`];

                if (total_balance < total_cost) {
                    res.status(400).json({ message: 'Not enough money to purchase pet.', status: 'NOT_ENOUGH_MONEY' });
                    throw new Error('Transaction aborted: Not enough money.');
                };

                let $USER_FILTER, $USER_UPDATE, $LOG_INSERT, $RESPONSE;

                if (tgp_balance >= total_cost) {
                    $USER_FILTER = { 'balances.tgp': { $gte: total_cost } };
                    $USER_UPDATE = { $inc: { 'balances.tgp': -total_cost, 'totals.tgp_spent': total_cost, 'totals.tgp_spent_pet': total_cost } };
                    $LOG_INSERT = { tgp_cost: total_cost };
                    $RESPONSE = { tgp_cost: total_cost };
                } else {
                    const tgpet_cost = total_cost - tgp_balance;
                    $USER_FILTER = { 'balances.tgp': { $gte: tgp_balance }, 'balances.tgpet': { $gte: tgpet_cost } };
                    $USER_UPDATE = { $inc: { 'balances.tgp': -tgp_balance, 'balances.tgpet': -tgpet_cost, 'totals.tgp_spent': tgp_balance, 'totals.tgp_spent_pet': tgp_balance, 'totals.tgpet_spent': tgpet_cost, 'totals.tgpet_spent_pet': tgpet_cost } };
                    $LOG_INSERT = { tgp_cost: tgp_balance, tgpet_cost };
                    $RESPONSE = { tgp_cost: tgp_balance, tgpet_cost };
                };

                const now_date = new Date();

                const [update_user_result, insert_pet_result, insert_log_result] = await Promise.all([
                    userCollection.updateOne(
                        { tele_id: tele_user.tele_id, ...$USER_FILTER },
                        { ...$USER_UPDATE, $inc: { ...$USER_UPDATE.$inc, 'totals.spent': total_cost, 'totals.spent_pet': total_cost } },
                        { session }
                    ),
                    petCollection.insertOne(
                        { tele_id: tele_user.tele_id, type: pet_name, level: pet_level, mana: new Date(now_date.getTime() + (pet.max_mana * 28800000)), accumulate_total_cost: total_cost },
                        { session }
                    ),
                    logCollection.insertOne(
                        { log_type: 'store/pet', tele_id: tele_user.tele_id, pet_name, total_cost, tgp_balance, tgpet_balance, total_balance, created_at: now_date, ...$LOG_INSERT },
                        { session }
                    )
                ]);

                if (update_user_result.modifiedCount > 0 && insert_pet_result.acknowledged === true && insert_log_result.acknowledged === true) {
                    res.status(200).json($RESPONSE);
                } else {
                    res.status(500).json({ message: 'Transaction failed to commit.' });
                    throw new Error('Transaction failed to commit.');
                };
            });
        } catch (error) {
            console.error(error);
            if (!res.headersSent) {
                res.status(500).json({ message: 'Internal server error.' });
            };
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}