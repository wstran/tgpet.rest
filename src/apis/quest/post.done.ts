import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

type OneTimeType = { [key: string | '_doned']: { created_at: Date } | 'pending_confirmation' | Date };

export default function (router: Router) {
    router.post('/quest/done', Middleware, async (req, res) => {
        const { quest_id } = req.body;

        const config_onetime_quests = CONFIG.GET('game_onetime_quests');

        if (typeof quest_id !== 'string' || !config_onetime_quests.quests[quest_id]?._state === true) {
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
                ) as { quests?: Record<string, OneTimeType | undefined> } | null;

                if (!user) {
                    res.status(404).json({ message: 'User not found.' });
                    throw new Error('Transaction aborted: User not found.');
                };

                user.quests = user.quests || {};

                const is_done = user.quests[quest_id]?._doned === 'pending_confirmation';

                if (!is_done) {
                    res.status(400).json({ message: 'Quest not marked as pending confirmation.' });
                    throw new Error('Transaction aborted: Quest not marked as pending confirmation.');
                };

                const now_date = new Date();

                const config_quest = config_onetime_quests.quests[quest_id]._rewards as { [key: string]: { amount: number, type: 'food' | 'token' } };

                const $inc: Record<string, number> = {};

                const $RESPONSE: { [key: string]: any } = { created_at: now_date };

                for (const name in config_quest) {
                    if (config_quest[name].type === 'food') {
                        $inc[`inventorys.${name}`] = config_quest[name].amount;
                        $RESPONSE[config_quest[name].type] = {
                            [name]: config_quest[name].amount
                        };
                    } else if (config_quest[name].type === 'token') {
                        $inc[`balances.${name}`] = config_quest[name].amount;
                        $RESPONSE[config_quest[name].type] = {
                            [name]: config_quest[name].amount
                        };
                    };
                };

                const [update_user_result, insert_log_result] = await Promise.all([
                    userCollection.updateOne(
                        { tele_id: tele_user.tele_id },
                        { $set: { [`quests.${quest_id}._doned`]: now_date }, $inc },
                        { session }
                    ),
                    logCollection.insertOne(
                        { log_type: 'quest/done', tele_id: tele_user.tele_id, quest_id, _rewards: config_quest, created_at: now_date },
                        { session }
                    )
                ]);

                if (update_user_result.modifiedCount > 0 && insert_log_result.acknowledged === true) {
                    res.status(200).json($RESPONSE);
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