import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
// import { claim_XLOTP } from '../../libs/blast';
import CryptoJS from 'crypto-js';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const REDIS_KEY = 'LOTTEFI_API';

export default function (router: Router) {
    router.post("/rewards/friend", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        if (await redisWrapper.has(REDIS_KEY, tele_user.tele_id)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15);

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');
        const logCollection = db.collection('logs');

        const session = client.startSession();

        try {
            session.startTransaction();

            const user = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { xlotp_rewards: 1, 'wallet.private_key': 1 } });

            if (user === null) {
                res.status(403).json({ message: 'Invalid user data' });
                return;
            };

            if (user.xlotp_rewards && user.xlotp_rewards === 0) {
                res.status(403).json({ message: 'Error xlotp_rewards is not define' });
                return;
            };

            const result = await userCollection.updateOne({ tele_id: tele_user.tele_id }, { $set: { xlotp_rewards: 0 }, $inc: { total_xlotp_rewards: user.xlotp_rewards } }, { session });

            const log_result = await logCollection.insertOne({ type: 'claim_friend_xlotp', tele_id: tele_user.tele_id, amount: user.xlotp_rewards, created_at: new Date(), status: 'pending' });

            if (result.acknowledged === true && result.modifiedCount > 0) {
                // const private_key = CryptoJS.AES.decrypt(user.wallet.private_key, process.env.SECRET_KEY!).toString(CryptoJS.enc.Utf8);

                // const transaction_receipt = await claim_XLOTP(private_key, user.xlotp_rewards.toFixed(8));

                const claim_result = await userCollection.updateOne({ tele_id: tele_user.tele_id }, { $inc: { 'balances.xlotp': user.xlotp_rewards } }, { session });

                if (claim_result.acknowledged === true && claim_result.modifiedCount > 0) {
                    await logCollection.updateOne({ _id: log_result.insertedId }, { $set: { status: 'success', sucess_at: new Date(), offchain_updated: true } });

                    await session.commitTransaction();

                    res.status(200).send('ok');

                    return;
                };
            };

            throw Error('Query is not acknowledged');
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