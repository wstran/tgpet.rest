import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/store/pet', Middleware, async (req, res) => {
        const { pet_name, pet_level, token } = req.body;

        const config_store = CONFIG.GET('store');

        const config_game_pets = CONFIG.GET('game_pets');

        const pet = { ...config_store.pets[pet_name]?.find((pet: { level: number }) => pet.level === pet_level), ...config_game_pets.pets[pet_name] };

        if (typeof pet_name !== 'string' || typeof pet_level !== 'number' || pet_level < 0 || pet_level > 50 || !pet || (/* token !== 'tgp' &&  */token !== 'tgpet')) {
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

                const balance = user.balances?.[token] || 0;
                const total_cost = pet.cost;

                if (balance < total_cost) {
                    res.status(400).json({ message: 'Not enough money to purchase pet.', status: 'NOT_ENOUGH_MONEY' });
                    throw new Error('Transaction aborted: Not enough money.');
                };

                const now_date = new Date();

                const [update_user_result, insert_pet_result, insert_log_result] = await Promise.all([
                    userCollection.updateOne(
                        { tele_id: tele_user.tele_id, [`balances.${token}`]: { $gte: total_cost } },
                        { $inc: {
                            [`balances.${token}`]: -total_cost,
                            'totals.spent': total_cost,
                            'totals.spent_pet': total_cost,
                            [`totals.${token}_spent`]: total_cost,
                            [`totals.${token}_spent_pet`]: total_cost },
                            [`totals.buy_pet_${token}_${pet_name}_amount`]: 1,
                            [`totals.buy_pet_${pet_name}_amount`]: 1,
                        },
                        { session }
                    ),
                    petCollection.insertOne(
                        { tele_id: tele_user.tele_id, type: pet_name, level: pet_level, mana: new Date(now_date.getTime() + (pet.max_mana * 28800000)), accumulate_total_cost: total_cost },
                        { session }
                    ),
                    logCollection.insertOne(
                        { log_type: 'store/pet', tele_id: tele_user.tele_id, pet_name, token, total_cost, created_at: now_date },
                        { session }
                    )
                ]);

                if ((update_user_result.modifiedCount > 0 ||  total_cost === 0) && insert_pet_result.acknowledged === true && insert_log_result.acknowledged === true) {
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
        };
    });
}