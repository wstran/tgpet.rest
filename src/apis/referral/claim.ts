import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';
// DEV
export default function (router: Router) {
    router.post('/referral/claim', Middleware, async (req, res) => {
        const { tele_user } = req as RequestWithUser;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');
        const petCollection = db.collection('pets');
        const todoCollection = db.collection('todos');
        const logCollection = db.collection('logs');

        const session = client.startSession({ causalConsistency: true, defaultTransactionOptions: { retryWrites: true } });

        try {
            session.startTransaction();

           /*  const user = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, invite_code: 1 }, session });

            if (user === null) {
                res.status(404).json({ message: 'Not found.' });
                return;
            };

            const referral_count = await userCollection.countDocuments({ referral_code: user.invite_code, referral_claimed: { $exists: false } }, { session }); */

            
        } catch (error) {
            await session.abortTransaction();
            res.status(500).json({ message: 'Internal server error.' });
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}