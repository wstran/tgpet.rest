import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { ObjectId } from 'mongodb';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/game/farm', Middleware, async (req, res) => {
        const { pet_id } = req.body;

        if (typeof pet_id !== 'string') {
            res.status(400).json({ message: 'Bad request.' });
            return;
        };

        const tele_user = (req as RequestWithUser).tele_user;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const petCollection = db.collection('pets');
        const logCollection = db.collection('logs');

        const session = client.startSession({ causalConsistency: true, defaultTransactionOptions: { retryWrites: true } });

        try {
            session.startTransaction();

            const pet_object_id = new ObjectId(pet_id);

            const pet = await petCollection.findOne({ _id: pet_object_id }, { projection: { _id: 0, farm_at: 1, mana: 1 }, session });

            if (pet === null) {
                res.status(404).json({ message: 'Not found.', status: 'PET_NOT_FOUND' });
                return;
            };

            const now_date = new Date();
            const mana_timestamp = pet.mana.getTime();

            if (now_date.getTime() >= mana_timestamp) {
                res.status(200).json({ status: 'PET_IS_OUT_OF_MANA' });
                return;
            };

            if (pet.farm_at) {
                res.status(200).json({ status: 'PET_ALREADY_FARMING' });
                return;
            };

            const [pet_update_result, insert_log_result] = await Promise.all([
                petCollection.updateOne({ _id: pet_object_id }, { $set: { farm_at: now_date } }),
                logCollection.insertOne({ log_type: 'game/farm', tele_id: tele_user.tele_id, pet_object_id, created_at: now_date })
            ]);

            if (
                pet_update_result.acknowledged === true && pet_update_result.modifiedCount > 0 &&
                insert_log_result.acknowledged === true
            ) {
                await session.commitTransaction();
            };

            res.status(200).json({ farm_at: now_date });
        } catch (error) {
            await session.abortTransaction();
            res.status(500).json({ message: 'Internal server error.' });
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}