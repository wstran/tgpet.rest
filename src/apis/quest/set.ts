import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

type OneTimeType = { [key: string]: { created_at: Date } };

export default function (router: Router) {
    router.post('/quest/set', Middleware, async (req, res) => {
        const { quest_id, action } = req.body;

        const config_onetime_quests = CONFIG.GET('game_onetime_quests');

        if (typeof quest_id !== 'string' || typeof action !== 'string' || !config_onetime_quests.quests[quest_id]?.[action]) {
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

            const user = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, [`onetime_quests.${quest_id}`]: 1 }, session }) as { onetime_quests?: Record<string, OneTimeType | undefined> } | null;

            if (user === null) {
                return res.status(404).json({ message: 'Not found.' });
            };

            user.onetime_quests = user.onetime_quests || {};

            const quest = user.onetime_quests[quest_id];

            if (quest?.[action]) {
                return res.status(404).json({ message: 'Not found.' });
            };

            const now_date = new Date();

            const is_done = quest && Object.keys(config_onetime_quests.quests[quest_id]).findIndex((i) => !quest[i]) === -1;

            const [update_user_result, insert_log_result] = await Promise.all([
                userCollection.updateOne(
                    { tele_id: tele_user.tele_id },
                    {
                        $set: {
                            [`ontime_quests.${quest_id}.${action}.created_at`]: now_date,
                            ...(is_done && {
                                [`ontime_quests.${quest_id}._doned`]: 'pending_confirmation'
                            })
                        }
                    }, { session }),
                logCollection.insertOne({ log_type: 'quest/set', tele_id: tele_user.tele_id, quest_id, action, created_at: now_date }, { session })
            ]);

            if (update_user_result.acknowledged === true &&
                update_user_result.modifiedCount > 0 &&
                insert_log_result.acknowledged === true) {
                await session.commitTransaction();

                return res.status(200).end();
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