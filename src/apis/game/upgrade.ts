import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { ObjectId } from 'mongodb';
import { caculateFarmBoost, Pet } from './libs';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/game/upgrade', Middleware, async (req, res) => {
        const { pet_id } = req.body;

        if (typeof pet_id !== 'string') {
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
        const petCollection = db.collection('pets');
        const logCollection = db.collection('logs');

        const session = client.startSession({ causalConsistency: true, defaultTransactionOptions: { retryWrites: true } });

            try {
                session.startTransaction();

                const pet_object_id = new ObjectId(pet_id);

                const [user, pet] = await Promise.all([
                    userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, balances: 1, boosts: 1 }, session }),
                    petCollection.findOne({ _id: pet_object_id }, { projection: { _id: 1, level: 1, mana: 1, farm_at: 1, accumulate_total_cost: 1 }, session }) as Promise<Pet>
                ]);

                if (user === null) {
                    return res.status(404).json({ message: 'Not found.' });
                };

                if (pet === null) {
                    return res.status(404).json({ message: 'Not found.', status: 'PET_NOT_FOUND' });
                };

                if (pet.level === 50) {
                    return res.status(404).json({ message: 'Not found.', status: 'PET_MAX_LEVEL' });
                };

                const config_farm_data = CONFIG.GET('farm_data');

                const tgp_balance = (user.balances?.tgp || 0);
                
                const tgpet_balance = (user.balances?.tgpet || 0);

                const total_balance = tgp_balance + tgpet_balance;

                const upgrade_cost = config_farm_data[`cost_level_${pet.level + 1}`];

                if (total_balance < upgrade_cost) {
                    return res.status(404).json({ message: 'Not found.', status: 'NOT_ENOUGH_MONEY' });
                };

                let $USER_FILTER, $USER_UPDATE, $PET_UPDATE, $LOG_INSERT, $RESPONSE;

                if (tgp_balance >= upgrade_cost) {
                    $USER_FILTER = { 'balances.tgp': { $gte: upgrade_cost } };
                    
                    $USER_UPDATE = { $inc: { 'balances.tgp': -upgrade_cost, 'totals.tgp_spent': upgrade_cost, 'totals.tgp_spent_upgrade': upgrade_cost } };
                    
                    $LOG_INSERT = { tgp_cost: upgrade_cost };

                    $RESPONSE = { tgp_cost: upgrade_cost };
                } else {
                    const tgpet_cost = upgrade_cost - tgp_balance;

                    $USER_FILTER = { 'balances.tgp': { $gte: tgp_balance }, 'balances.tgpet': { $gte: tgpet_cost } };
                    
                    $USER_UPDATE = { $inc: { 'balances.tgp': -tgp_balance, 'balances.tgpet': -tgpet_cost, 'totals.tgp_spent': tgp_balance, 'totals.tgp_spent_upgrade': tgp_balance, 'totals.tgpet_spent': tgpet_cost, 'totals.tgpet_spent_upgrade': tgpet_cost } };
                    
                    $LOG_INSERT = { tgp_cost: tgp_balance, tgpet_cost };
                    
                    $RESPONSE = { tgp_cost: tgp_balance, tgpet_cost };
                }

                const date_timestamp = Date.now();
                const mana_timestamp = pet.mana.getTime();
                const farm_timestamp = pet.farm_at?.getTime();

                if (farm_timestamp && date_timestamp >= mana_timestamp) {

                    const farm_speed = (pet.accumulate_total_cost - config_farm_data.x_average_TGP) / config_farm_data.y_day_to_break_even;

                    const farm_points = ((mana_timestamp - farm_timestamp) / (24 * 60 * 60 * 1000)) * farm_speed;

                    const boost_points = caculateFarmBoost(date_timestamp, [pet], user?.boosts || []);

                    const total_points = farm_points + boost_points;

                    $PET_UPDATE = { $unset: { farm_at: 1 }, $inc: { level: 1, balance: total_points, accumulate_total_cost: upgrade_cost } };

                    $LOG_INSERT = { ...$LOG_INSERT, tgp_balance, tgpet_balance, total_balance, farm_points, boost_points, total_points };

                    $RESPONSE = { ...$RESPONSE, total_points };
                } else {
                    $PET_UPDATE = { $unset: { farm_at: 1 }, $inc: { level: 1, accumulate_total_cost: upgrade_cost } };

                    $LOG_INSERT = { ...$LOG_INSERT, tgp_balance, tgpet_balance, total_balance };

                    $RESPONSE = { ...$RESPONSE, tgp_balance, tgpet_balance };
                }
                
                const [update_user_result, update_pet_result, insert_log_result] = await Promise.all([
                    userCollection.updateOne({ tele_id: tele_user.tele_id, ...$USER_FILTER }, { ...$USER_UPDATE, $inc: { ...$USER_UPDATE.$inc, 'totals.spent': upgrade_cost, 'totals.spent_upgrade': upgrade_cost } }, { session }),
                    petCollection.updateOne({ _id: pet._id }, { ...$PET_UPDATE }, { session }),
                    logCollection.insertOne({ log_type: 'game/upgrade', tele_id: tele_user.tele_id, from_level: pet.level, to_level: pet.level + 1, upgrade_cost, pet_before: pet, created_at: new Date(date_timestamp), ...$LOG_INSERT }, { session })
                ]);
    
                if (
                    update_user_result.modifiedCount > 0 &&
                    update_pet_result.modifiedCount > 0 &&
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