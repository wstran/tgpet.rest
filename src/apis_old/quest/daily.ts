import { Router } from 'express';
// import CryptoJS from 'crypto-js';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
// import { claim_XLOTP } from '../../libs/blast';
import { toBase64 } from '../../libs/base64';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const REDIS_KEY = 'LOTTEFI_API';

export default function (router: Router) {
    router.post("/quest/daily", Middleware, async (req, res) => {
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

            const get_quest_config = await configCollection.findOne({ config_type: 'quest', quest_id }, { projection: { duration: 1, _quest: 1 } });

            if (get_quest_config === null) {
                throw Error('Invalid server data');
            };

            if (get_quest_config.duration !== 'daily') {
                throw Error('Invalid quest duration');
            };

            const claim_date = new Date();

            claim_date.setUTCDate(claim_date.getUTCDate() - 1);

            claim_date.setUTCHours(12, 0, 0, 0);

            const now_date = new Date();

            now_date.setUTCHours(12, 0, 0, 0);

            const result = await userCollection.bulkWrite([
                {
                    updateOne: {
                        filter: {
                            tele_id: tele_user.tele_id, $or: [
                                { [`_quest`]: { $exists: false } },
                                { [`_quest.${quest_id}`]: { $exists: false } },
                            ]
                        },
                        update: {
                            $set: {
                                [`_quest.${quest_id}.created_at`]: new Date(),
                            }
                        }
                    }
                },
                {
                    updateOne: {
                        filter: { tele_id: tele_user.tele_id, [`_quest.${quest_id}.claim_date`]: claim_date },
                        update: [
                            {
                                $set: {
                                    [`_quest.${quest_id}.claim_day`]: {
                                        $cond: {
                                            if: { $gt: [`$_quest.${quest_id}.claim_day`, 0] },
                                            then: {
                                                $cond: {
                                                    if: { $lt: [`$_quest.${quest_id}.claim_day`, 7] },
                                                    then: { $add: [`$_quest.${quest_id}.claim_day`, 1] },
                                                    else: 1
                                                }
                                            },
                                            else: 1
                                        }
                                    },
                                    [`_quest.${quest_id}.claim_date`]: now_date,
                                }
                            }
                        ]
                    }
                },
                {
                    updateOne: {
                        filter: {
                            tele_id: tele_user.tele_id, $and: [
                                { [`_quest.${quest_id}.claim_date`]: { $ne: claim_date } },
                                { [`_quest.${quest_id}.claim_date`]: { $ne: now_date } },
                            ]
                        },
                        update: {
                            $set: {
                                [`_quest.${quest_id}.claim_day`]: 1,
                                [`_quest.${quest_id}.claim_date`]: now_date,
                            }
                        }
                    }
                },
            ], { session });

            if (result.matchedCount > 0 && result.modifiedCount > 0) {
                const user = await userCollection.findOne({ tele_id: tele_user.tele_id, [`_quest.${quest_id}.claim_day`]: { $exists: true } }, { projection: { 'wallet.private_key': 1, [`_quest.${quest_id}`]: 1 }, session });

                if (user == null) {
                    throw Error('Error could not find the claim_day');
                };

                const claim_day = user._quest[quest_id].claim_day;

                const xlotp_rewards = get_quest_config._quest.find((i: { day: number }) => i.day === claim_day).reward_amount;

                if (typeof xlotp_rewards !== 'number') {
                    throw Error('Error xlotp_rewards is not the number');
                };

                const log_result = await logCollection.insertOne({ type: 'claim_xlotp_daily_quest', tele_id: tele_user.tele_id, amount: xlotp_rewards, quest_id, quest_data: user._quest[quest_id], created_at: new Date(), status: 'pending' });

                // const private_key = CryptoJS.AES.decrypt(user.wallet.private_key, process.env.SECRET_KEY!).toString(CryptoJS.enc.Utf8);

                // const transaction_receipt = await claim_XLOTP(private_key, xlotp_rewards.toString());

                const claim_result = await userCollection.updateOne({ tele_id: tele_user.tele_id }, { $inc: { 'balances.xlotp': xlotp_rewards } }, { session });

                if (claim_result.acknowledged === true && claim_result.modifiedCount > 0) {
                    await logCollection.updateOne({ _id: log_result.insertedId }, { $set: { status: 'success', sucess_at: new Date(), offchain_updated: true } });

                    await session.commitTransaction();

                    res.status(200).json(toBase64({ quest_data: user._quest[quest_id], amount: xlotp_rewards }));

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