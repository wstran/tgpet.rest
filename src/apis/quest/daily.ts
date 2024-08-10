import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

type DailyType = { streak: number, max_streak: number, checkin_at: Date };

export default function (router: Router) {
    router.post('/quest/daily', Middleware, async (req, res) => {
        const { quest_id } = req.body;

        const config_daily_quests = CONFIG.GET('game_daily_quests');

        if (typeof quest_id !== 'string' || !config_daily_quests.quests[quest_id]) {
            return res.status(400).json({ message: 'Bad Request' });
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

            const user = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, [`daily_quests.${quest_id}`]: 1 }, session }) as { daily_quests?: Record<string, DailyType | undefined> } | null;

            if (user === null) {
                return res.status(404).json({ message: 'Not found.' });
            };

            user.daily_quests = user.daily_quests || {};

            const quest = user.daily_quests[quest_id];

            const now_date = new Date();

            now_date.setUTCHours(12, 0, 0, 0);

            let $USER_UPDATE;

            if (quest?.checkin_at !== now_date) {
                const yester_day = new Date();

                yester_day.setUTCDate(yester_day.getUTCDate() - 1);

                yester_day.setUTCHours(12, 0, 0, 0);

                if (quest?.checkin_at.getTime() === yester_day.getTime()) {
                    $USER_UPDATE = { $inc: { [`_quests.${quest_id}.streak`]: 1 } };

                    if (quest.streak + 1 > quest.max_streak) {
                        $USER_UPDATE.$inc[`_quests.${quest_id}.max_streak`] = quest.streak + 1;
                    };
                } else {
                    $USER_UPDATE = { $set: { [`_quests.${quest_id}.streak`]: 1 } };
                };
            } else {
                return res.status(404).json({ message: 'Not found.' });
            };

            const [update_user_result, insert_log_result] = await Promise.all([
                userCollection.updateOne({ tele_id: tele_user.tele_id }, { ...$USER_UPDATE, $set: { ...$USER_UPDATE?.$set, [`_quests.${quest_id}.checkin_at`]: now_date } }, { session }),
                logCollection.insertOne({ log_type: 'quest/daily', tele_id: tele_user.tele_id, quest_id, quest, created_at: now_date }, { session })
            ]);

            if (update_user_result.acknowledged === true &&
                update_user_result.modifiedCount > 0 &&
                insert_log_result.acknowledged === true) {
                await session.commitTransaction();

                return res.status(200).end();
            }
        } catch (error) {
            await session.abortTransaction();
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };

        return res.status(500).json({ message: 'Internal server error.' });
    });
}