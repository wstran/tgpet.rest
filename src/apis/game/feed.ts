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
    router.post('/game/feed', Middleware, async (req, res) => {
        const { pet_id, item_name } = req.body;

        const config_game_items = CONFIG.GET('game_items');

        if (typeof pet_id !== 'string' || typeof item_name !== 'string' || !config_game_items.items[item_name]) {
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
                const pet_object_id = new ObjectId(pet_id);

                const [user, pet] = await Promise.all([
                    userCollection.findOne({ tele_id: tele_user.tele_id, [`inventorys.${item_name}`]: { $gte: 1 } }, { projection: { _id: 0, boosts: 1 }, session }),
                    petCollection.findOne({ _id: pet_object_id }, { projection: { _id: 1, mana: 1, farm_at: 1, accumulate_total_cost: 1, type: 1 }, session }) as Promise<Pet>
                ]);

                if (user === null) {
                    res.status(404).json({ message: 'Not found.', status: 'NOT_ENOUGH_FOOD' });
                    throw new Error('Transaction aborted: NOT_ENOUGH_FOOD');
                };

                const config_pets = CONFIG.GET('game_pets').pets;

                if (pet === null || !config_pets[pet.type]) {
                    res.status(404).json({ message: 'Not found.', status: 'PET_NOT_FOUND' });
                    throw new Error('Transaction aborted: PET_NOT_FOUND');
                };

                const date_timestamp = Date.now();
                const mana_timestamp = pet.mana.getTime();
                const farm_timestamp = pet.farm_at?.getTime();

                const max_mana = date_timestamp + (config_pets[pet.type].max_mana * 28800000);

                const new_mana = (date_timestamp > mana_timestamp ? date_timestamp : mana_timestamp) + (config_game_items.items[item_name].mana * 28800000);

                const mana = new Date(new_mana > max_mana ? max_mana : new_mana);

                let $PET_UPDATE, $LOG_INSERT, $RESPONSE;

                if (farm_timestamp && date_timestamp >= mana_timestamp) {
                    const config_farm_data = CONFIG.GET('farm_data');

                    const farm_speed = (pet.accumulate_total_cost - config_farm_data.x_average_TGP) / config_farm_data.y_day_to_break_even;

                    const farm_points = ((mana_timestamp - farm_timestamp) / (24 * 60 * 60 * 1000)) * farm_speed;

                    const boost_points = caculateFarmBoost(date_timestamp, [pet], user?.boosts || []);

                    const total_points = farm_points + boost_points;

                    $PET_UPDATE = { $unset: { farm_at: 1 }, $inc: { balance: total_points } };

                    $LOG_INSERT = { farm_points, boost_points, total_points, unset_farm_at: true };

                    $RESPONSE = { mana, total_points, unset_farm_at: true };
                } else {
                    $RESPONSE = { mana };
                };

                const [update_user_result, update_pet_result, insert_log_result] = await Promise.all([
                    userCollection.updateOne({ tele_id: tele_user.tele_id, [`inventorys.${item_name}`]: { $gte: 1 } }, { $inc: { [`inventorys.${item_name}`]: -1 } }, { session }),
                    petCollection.updateOne({ _id: pet._id }, { $set: { mana }, ...$PET_UPDATE }, { session }),
                    logCollection.insertOne({ log_type: 'game/feed', tele_id: tele_user.tele_id, mana, item_name, pet_beforce: pet, created_at: new Date(date_timestamp), ...$LOG_INSERT }, { session })
                ]);

                if (
                    update_user_result.modifiedCount > 0 &&
                    update_pet_result.modifiedCount > 0 &&
                    insert_log_result.acknowledged === true
                ) {
                    res.status(200).json($RESPONSE);
                } else {
                    res.status(500).json({ message: 'Transaction failed', status: 'TRANSACTION_FAILED' });
                    throw new Error('Transaction failed');
                };
            });
        } catch (error) {
            console.error(error);
            if (!res.headersSent) {
                res.status(500).json({ message: 'Internal server error.' });
            }
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}