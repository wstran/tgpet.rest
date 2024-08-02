import { Router, Response } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const REDIS_KEY = 'LOTTEFI_API';

export const handleError = (error: unknown, res: Response): void => {
    if (!res.headersSent) {
        if (error instanceof Error) {
            res.status(500).json({ message: error.message });
        } else {
            res.status(500).json({ message: 'An unknown error occurred' });
        }
    }
};

export default function (router: Router) {
    router.post("/quest/set", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;
        const { quest_id, action } = req.body;

        if (typeof quest_id !== 'string' || typeof action !== 'string') {
            res.status(400).json({ message: 'Bad Request' });
            return;
        }

        if (await redisWrapper.has(REDIS_KEY, tele_user.tele_id)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        }

        await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15);

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const configCollection = db.collection('config');
        const userCollection = db.collection('users');

        const session = client.startSession();

        try {
            session.startTransaction();

            const get_quest_config = await configCollection.findOne(
                { config_type: 'quest', quest_id }, 
                { projection: { duration: 1, _quest: 1 } }
            );

            if (!get_quest_config || !get_quest_config._quest || !get_quest_config._quest[action]) {
                throw new Error('Invalid server data');
            }

            if (get_quest_config.duration !== 'life_time') {
                throw new Error('Invalid quest duration');
            }

            const result = await userCollection.bulkWrite([
                {
                    updateOne: {
                        filter: {
                            tele_id: tele_user.tele_id, 
                            $or: [
                                { [`_quest`]: { $exists: false } },
                                { [`_quest.${quest_id}`]: { $exists: false } },
                                { [`_quest.${quest_id}.${action}`]: { $exists: false } },
                            ]
                        },
                        update: { $set: { [`_quest.${quest_id}.${action}`]: { created_at: new Date() } } },
                    }
                },
            ], { session });

            if (result.matchedCount > 0 && result.modifiedCount > 0) {
                await session.commitTransaction();
                res.status(200).send('ok');
                return;
            } else {
                throw new Error('Query is not acknowledged');
            }
        } catch (error) {
            console.error(error);
            await session.abortTransaction();
            handleError(error, res);
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        }
    });
};
