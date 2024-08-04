import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.get('/referral/history', Middleware, async (req, res) => {
        const { page, limit } = req.params;

        if (typeof page !== 'number' || typeof limit !== 'number' || page < 1 || limit < 1 || limit > 10) {
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
        const userCollection = db.collection('users');
        try {
            const user = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, invite_code: 1 } });

            if (user === null) {
                res.status(404).json({ message: 'Not found.' });
                return;
            };

            const user_refs = await userCollection.find({ referral_code: user.invite_code }).project({ _id: 0, name: 1, username: 1 }).skip(page).limit(limit).toArray();
            
            res.status(200).json(user_refs);
        } catch (error) {
            res.status(500).json({ message: 'Internal server error.' });
        } finally {
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}