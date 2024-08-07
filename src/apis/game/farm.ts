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
            return res.status(400).json({ message: 'Bad request.' });
        };

        const { tele_user } = req as RequestWithUser;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            return res.status(429).json({ message: 'Too many requests.' });
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
                return res.status(404).json({ message: 'Not found.', status: 'PET_NOT_FOUND' });
            };

            const now_date = new Date();
            const mana_timestamp = pet.mana.getTime();

            if (now_date.getTime() >= mana_timestamp) {
                return res.status(404).json({ message: 'Not found.', status: 'PET_IS_OUT_OF_MANA' });
            };

            if (pet.farm_at) {
                return res.status(404).json({ message: 'Not found.', status: 'PET_ALREADY_FARMING' });
            };

            const [pet_update_result, insert_log_result] = await Promise.all([
                petCollection.updateOne({ _id: pet_object_id }, { $set: { farm_at: now_date } }, { session }),
                logCollection.insertOne({ log_type: 'game/farm', tele_id: tele_user.tele_id, pet_object_id, created_at: now_date }, { session })
            ]);

            if (
                pet_update_result.acknowledged === true && pet_update_result.modifiedCount > 0 &&
                insert_log_result.acknowledged === true
            ) {
                await session.commitTransaction();

                return res.status(200).json({ farm_at: now_date });
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