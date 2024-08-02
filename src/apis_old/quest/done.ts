import { Router } from 'express';
import CryptoJS from 'crypto-js';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
// import { claim_XLOTP } from '../../libs/blast';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { getRandomInt } from '../../libs/custom';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const REDIS_KEY = 'LOTTEFI_API';

const lifetime = 60 * 60 * 24 * 365 * 100; // 100 years

const events = [
    { catch_refs_count: 3, boost_id: 'invite_friends', boost_percent: 0, boost_sec: lifetime },
    { catch_refs_count: 4, boost_id: 'invite_friends', boost_percent: 10, boost_sec: lifetime },
    { catch_refs_count: 11, boost_id: 'invite_friends', boost_percent: 15, boost_sec: lifetime },
    { catch_refs_count: 21, boost_id: 'invite_friends', boost_percent: 20, boost_sec: lifetime },
    { catch_refs_count: 51, boost_id: 'invite_friends', boost_percent: 50, boost_sec: lifetime },
];

// type Boost_Ranking = 'normal' | 'sliver' | 'gold' | 'platium' | 'diamond';

/* const getBoostRanking = (get_boost_ranking_config: { [key: string]: any }, total_verified_refs: number): Boost_Ranking | null => {
    if (total_verified_refs > 100) total_verified_refs = 100;

    const configs = Object.entries(get_boost_ranking_config);

    for (let i = 0; i < configs.length; ++i) {
        if (total_verified_refs >= configs[i][1].min_ref && total_verified_refs <= configs[i][1].max_ref) {
            return configs[i][0] as Boost_Ranking;
        };
    };

    return null;
}; */

export default function (router: Router) {
    router.post("/quest/done", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        const { quest_id } = req.body;

        if (typeof quest_id !== 'string') {
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
        const configCollection = db.collection('config');
        const userCollection = db.collection('users');
        const logCollection = db.collection('logs');

        const session = client.startSession();

        try {
            session.startTransaction();

            const [user, get_quest_config] = await Promise.all([
                userCollection.findOne({
                    tele_id: tele_user.tele_id, $or: [
                        { _quest: { $exists: false } },
                        { [`_quest.${quest_id}`]: { $exists: false } },
                        { [`_quest.${quest_id}._done_at`]: { $exists: false } },
                    ]
                }, { projection: { _id: 0, referral_code: 1, 'wallet.private_key': 1 } }),
                configCollection.findOne({ config_type: 'quest', quest_id }, { projection: { duration: 1, _quest: 1, _rewards: 1, active: 1 } }),
            ]);

            if (user === null || get_quest_config === null) {
                throw Error('Invalid server data');
            };

            if (get_quest_config.active !== true) {
                throw Error('Quest is not active');
            };

            const result = await userCollection.bulkWrite([
                {
                    updateOne: {
                        filter: { tele_id: tele_user.tele_id, ...Object.keys(get_quest_config._quest).reduce((prev, action) => ({ ...prev, [`_quest.${quest_id}.${action}`]: { $exists: true } }), {}) },
                        update: { $set: { [`_quest.${quest_id}._done_at`]: new Date() } },
                    }
                },
                {
                    updateOne: {
                        filter: { tele_id: tele_user.tele_id, [`_quest.${quest_id}._done_at`]: { $exists: true } },
                        update: { $set: { farm_at: new Date() } },
                    }
                }
            ], { session });

            if (result.matchedCount > 0 && result.modifiedCount > 0) {
                if (result.modifiedCount === 2) {
                    if (quest_id === 'starter_quest') {
                        const update_total_verified_refs_result = await userCollection.findOneAndUpdate({ invite_code: user.referral_code, 'user_refs.tele_id': tele_user.tele_id }, { $set: { 'user_refs.$.verified': true }, $inc: { total_verified_refs: 1 } }, { returnDocument: 'after', projection: { _id: 0, total_verified_refs: 1 }, session });

                        if (update_total_verified_refs_result) {
                            if (!update_total_verified_refs_result.total_verified_refs) {
                                throw Error('Update `user_ref.verified` failed');
                            };

                            const get_events = events.find((i, index) => update_total_verified_refs_result.total_verified_refs >= i.catch_refs_count && (!events[index + 1] || update_total_verified_refs_result.total_verified_refs < events[index + 1].catch_refs_count));

                            if (get_events) {
                                const date = new Date();

                                const update_boost_result = await userCollection.updateOne(
                                    {
                                        invite_code: user.referral_code,
                                        boosts: { $exists: true },
                                        'boosts.boost_id': get_events.boost_id,
                                    },
                                    {
                                        $set: {
                                            "boosts.$.boost_percent": get_events.boost_percent,
                                            "boosts.$.start_at": date,
                                            "boosts.$.end_at": new Date(date.getTime() + Math.floor(get_events.boost_sec * 1000))
                                        }
                                    },
                                    { session },
                                );

                                if (update_boost_result.acknowledged === true && update_boost_result.modifiedCount === 0) {
                                    await userCollection.updateOne(
                                        {
                                            invite_code: user.referral_code,
                                        },
                                        {
                                            $addToSet: {
                                                boosts: {
                                                    boost_id: get_events.boost_id,
                                                    boost_percent: get_events.boost_percent,
                                                    start_at: date,
                                                    end_at: new Date(date.getTime() + Math.floor(get_events.boost_sec * 1000))
                                                }
                                            }
                                        },
                                        { session },
                                    );
                                };
                            };
                        };

                        await session.commitTransaction();

                        res.status(200).send('ok');

                        return;
                    } else {
                        if (!get_quest_config?._rewards?.xlotp_token || !user.wallet?.private_key) {
                            throw Error('Invalid server data');
                        };

                        let xlotp_token;

                        if (typeof get_quest_config._rewards.xlotp_token === 'number') {
                            xlotp_token = get_quest_config._rewards.xlotp_token as number;
                        } else {
                            xlotp_token = getRandomInt(...(get_quest_config._rewards.xlotp_token as [number, number]))
                        };

                        const log_result = await logCollection.insertOne({ type: 'claim_xlotp_quest', tele_id: tele_user.tele_id, amount: xlotp_token, quest_id, created_at: new Date(), status: 'pending' });

                        // const private_key = CryptoJS.AES.decrypt(user.wallet.private_key, process.env.SECRET_KEY!).toString(CryptoJS.enc.Utf8);

                        // const transaction_receipt = await claim_XLOTP(private_key, String(xlotp_token));

                        const claim_result = await userCollection.updateOne({ tele_id: tele_user.tele_id }, { $inc: { 'balances.xlotp': xlotp_token } }, { session });

                        if (claim_result.acknowledged === true && claim_result.modifiedCount > 0) {
                            await logCollection.updateOne({ _id: log_result.insertedId }, { $set: { status: 'success', sucess_at: new Date(), offchain_updated: true } });

                            await session.commitTransaction();

                            res.status(200).json({ xlotp_token });

                            return;
                        };
                    };
                };
            };

            throw Error(`Update \`_quest.${quest_id}._done_at\` failed`);
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