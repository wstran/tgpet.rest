import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const REDIS_KEY = 'LOTTEFI_API';

export default function (router: Router) {
    router.post("/referral/set", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        const { referral_code } = req.body;

        if (typeof referral_code !== 'string' || referral_code.length !== 8) {
            res.status(401).json({ message: 'Bad Request' });
            return;
        };

        if (await redisWrapper.has(REDIS_KEY, tele_user.tele_id)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15);

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');

        const session = client.startSession();

        try {
            session.startTransaction();

            const result = await userCollection.bulkWrite([
                {
                    updateOne: {
                        filter: { invite_code: referral_code, $or: [ { user_refs: { $exists: false } }, { 'user_refs.tele_id': { $ne: tele_user.tele_id } } ] },
                        update: { $push: { user_refs: { tele_id: tele_user.tele_id, referral_code: new Date() } } as any },
                    }
                },
                {
                    updateOne: {
                        filter: { tele_id: tele_user.tele_id, referral_code: { $exists: false } },
                        update: { $set: { referral_code } },
                    }
                },
            ], { session });

            if (result.modifiedCount === 2) {
                await session.commitTransaction();

                res.status(200).send('ok');
            } else {
                await session.abortTransaction();

                res.status(404).json({ message: 'Invalid Referral Code' });
            };
        } catch (error) {
            console.error(error);
            await session.abortTransaction();
            res.status(500).json({ message: 'Internal server error' });
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
};