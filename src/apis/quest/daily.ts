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
            res.status(400).json({ message: 'Bad request. Invalid quest ID.' });
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
                    { projection: { [`quests.${quest_id}`]: 1 }, session }
                ) as { quests?: Record<string, DailyType | undefined> } | null;

                if (!user) {
                    res.status(404).json({ message: 'User not found.' });
                    throw new Error('Transaction aborted: User not found.');
                };

                user.quests = user.quests || {};
                const quest = user.quests[quest_id];
                const now_date = new Date();
                now_date.setUTCHours(12, 0, 0, 0);

                let $USER_UPDATE;

                if (!quest || quest.checkin_at.getTime() !== now_date.getTime()) {
                    const yester_day = new Date();
                    yester_day.setUTCDate(yester_day.getUTCDate() - 1);
                    yester_day.setUTCHours(12, 0, 0, 0);

                    if (quest?.checkin_at.getTime() === yester_day.getTime()) {
                        $USER_UPDATE = { $inc: { [`quests.${quest_id}.streak`]: 1 } };
                        if (quest.streak + 1 > quest.max_streak) {
                            $USER_UPDATE.$inc[`quests.${quest_id}.max_streak`] = quest.streak + 1;
                        };
                    } else {
                        $USER_UPDATE = { $set: { [`quests.${quest_id}.streak`]: 1 } };
                    };
                } else {
                    res.status(400).json({ message: 'Quest already checked in today.' });
                    throw new Error('Transaction aborted: Quest already checked in today.');
                };

                const config_quest = config_daily_quests.quests[quest_id]._rewards as { [key: string]: { amount: number, type: 'food' | 'token' } };
                let $inc: { [key: string]: number } = {};

                for (const name in config_quest) {
                    if (config_quest[name].type === 'food') {
                        $inc[`inventorys.${name}`] = config_quest[name].amount;
                    } else if (config_quest[name].type === 'token') {
                        $inc[`balances.${name}`] = config_quest[name].amount;
                    };
                };

                const [update_user_result, insert_log_result] = await Promise.all([
                    userCollection.updateOne(
                        { tele_id: tele_user.tele_id },
                        { ...$USER_UPDATE, $set: { ...$USER_UPDATE.$set, [`quests.${quest_id}.checkin_at`]: now_date }, $inc: { ...$USER_UPDATE.$inc, ...$inc } },
                        { session }
                    ),
                    logCollection.insertOne(
                        { log_type: 'quest/daily', tele_id: tele_user.tele_id, quest_id, quest, _rewards: config_quest, created_at: now_date },
                        { session }
                    )
                ]);

                if (update_user_result.modifiedCount > 0 && insert_log_result.acknowledged === true) {
                    res.status(200).json({ created_at: now_date });
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