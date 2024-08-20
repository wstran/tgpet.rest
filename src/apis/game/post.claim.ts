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
        const { tele_user } = req as RequestWithUser;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            res.status(429).json({ message: 'Too many requests.' });
            return
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');
        const petCollection = db.collection('pets');
        const todoCollection = db.collection('todos');
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
                const [user, pets] = await Promise.all([
                    userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, referral_code: 1, boosts: 1, last_claimed: 1 }, session }),
                    petCollection.find({ tele_id: tele_user.tele_id }, { session }).project({ _id: 1, type: 1, farm_at: 1, mana: 1, balance: 1, accumulate_total_cost: 1 }).toArray()
                ]) as [WithId<Document> | null, Pet[]];

                if (!user || pets.length === 0) {
                    res.status(404).json({ message: 'User or pets not found.' });
                    throw new Error('Transaction aborted: User or pets not found.');
                };

                const now_date = new Date();

                if (user.last_claimed && now_date.getTime() - user.last_claimed.getTime() < 600000) {
                    res.status(400).json({ message: 'Claim too soon.' });
                    throw new Error('Transaction aborted: Claim too soon.');
                };

                const [farm_points, bulkOps] = caculateFarmAmount(pets, now_date);

                if (farm_points > 0 && bulkOps.length > 0) {
                    let total_points = farm_points;

                    const boost_points = caculateFarmBoost(now_date.getTime(), pets, user.boosts || []);

                    total_points += boost_points;

                    const [update_user_result, update_pet_result, update_todo_result, insert_log_result] = await Promise.all([
                        userCollection.updateOne({ tele_id: tele_user.tele_id }, { $set: { last_claimed: now_date }, $inc: { 'balances.tgp': total_points, 'totals.game_claim_tgp': total_points } }, { session }),
                        petCollection.bulkWrite(bulkOps, { session }),
                        user.referral_code ? todoCollection.insertOne({ todo_type: 'rest:game/claim/referral', status: "pending", tele_id: tele_user.tele_id, referral_code: user.referral_code, farm_points, created_at: now_date }, { session }) : Promise.resolve({ acknowledged: true }),
                        logCollection.insertOne({ log_type: 'game/claim', tele_id: tele_user.tele_id, farm_points, boost_points, total_points, created_at: now_date, pets_before: pets, bulkOps }, { session })
                    ]);

                    if (
                        update_user_result.modifiedCount > 0 &&
                        !update_pet_result.hasWriteErrors() &&
                        update_pet_result.modifiedCount > 0 &&
                        update_todo_result.acknowledged === true &&
                        insert_log_result.acknowledged === true
                    ) {
                        res.status(200).json({ total_points, created_at: now_date });
                    } else {
                        res.status(500).json({ message: 'Transaction failed to commit.' });
                        throw new Error('Transaction failed to commit.');
                    };
                } else {
                    res.status(400).json({ message: 'No farm points to claim.' });
                    throw new Error('Transaction aborted: No farm points to claim.');
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