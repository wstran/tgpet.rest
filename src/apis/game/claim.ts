import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { Document, WithId } from 'mongodb';
import { caculateFarmAmount, caculateFarmBoost, Pet } from './libs';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/game/claim', Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

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

        const session = client.startSession({ causalConsistency: true });

        try {
            session.startTransaction({ willRetryWrite: true });
            const [user, pets] = await Promise.all([
                userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, boosts: 1 } }),
                petCollection.find({ tele_id: tele_user.tele_id }, { session }).project({ _id: 1, farm_at: 1, mana: 1, balance: 1, accumulate_total_cost: 1 }).toArray()
            ]) as [WithId<Document> | null, Pet[]];

            const now_date = new Date();

            const [farm_points, bulkOps] = caculateFarmAmount(pets, now_date);

            let total_points = farm_points;

            if (farm_points > 0 && bulkOps.length > 0) {
                const boost_points = caculateFarmBoost(now_date.getTime(), user?.boosts || [], farm_points);

                total_points += boost_points;

                const [update_user_result, update_pet_result, insert_log_result] = await Promise.all([
                    userCollection.updateOne({ tele_id: tele_user.tele_id }, { $inc: { 'balances.tgp': total_points, 'totals.game_claim_tgp': total_points } }, { session }),
                    petCollection.bulkWrite(bulkOps, { session }),
                    logCollection.insertOne({ log_type: 'game/claim', tele_id: tele_user.tele_id, farm_points, boost_points, total_points, created_at: now_date, pets_before: pets, bulkOps }, { session })
                ]);

                if (
                    update_user_result.modifiedCount > 0 &&
                    !update_pet_result.hasWriteErrors() &&
                    update_pet_result.modifiedCount > 0 &&
                    insert_log_result.acknowledged === true
                ) {
                    await session.commitTransaction();
                };
            };

            res.status(200).json({ total_points });
        } catch (error) {
            await session.abortTransaction();
            res.status(500).json({ message: 'Internal server error.' });
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}