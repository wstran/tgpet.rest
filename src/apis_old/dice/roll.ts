import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { getRandomInt } from '../../libs/custom';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const REDIS_KEY = 'LOTTEFI_API';

function rollDiceWithRewards(global_total: number) {
    const percent = getRandomInt(1, 80/* global_total % 100 > 10 ? 80 : 100 */);

    if (percent <= 50) return getRandomInt(3, 9);

    if (percent <= 70) return getRandomInt(10, 14);

    if (percent <= 80) return getRandomInt(15, 17);

    return 18;
};

const getDice = (amount: number) => {
    if (amount > 2 && amount < 10) return { type: 'lotp', amount: 0.3 };
    if (amount > 9 && amount < 15) return { type: 'lotp', amount: 0.5 };
    if (amount > 14 && amount < 18) return { type: 'lotp', amount: 1 };
    if (amount === 18) return { type: 'ton', amount: 0.1 };
    return null;
};

export default function (router: Router) {
    router.post("/dice/roll", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        if (await redisWrapper.has(REDIS_KEY, tele_user.tele_id)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15);

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        // const client = dbInstance.getClient();
        const logCollection = db.collection("logs");
        const userCollection = db.collection("users");
        const metadataCollection = db.collection("metadata");

        // const session = client.startSession();

        try {
            // session.startTransaction();

            const get_dice_roll = await metadataCollection.findOne({ meta_id: 'dice_roll' }, { projection: { _id: 0, global_total: 1 } });

            const roll = rollDiceWithRewards(get_dice_roll?.global_total || 0);

            const dice = getDice(roll);

            if (dice !== null) {
                const result = await userCollection.updateOne({ tele_id: tele_user.tele_id, roll_amount: { $gte: 1 } }, { $inc: { roll_amount: -1, [`balances.${dice.type}`]: dice.amount } });

                if (result.acknowledged === true && result.modifiedCount > 0) {
                    await Promise.all([
                        metadataCollection.updateOne({ meta_id: 'dice_roll' }, { $setOnInsert: { meta_id: 'dice_roll' }, $inc: { global_total: 1, current_roll_amount: -1, [`total_${dice.type}_rewards`]: dice.amount } }, { upsert: true }),
                        logCollection.insertOne({ type: 'dice_roll', tele_id: tele_user.tele_id, roll, dice, created_at: new Date() }),
                    ]);

                    // await session.commitTransaction();

                    res.status(200).json({ roll, dice });
                } else {
                    res.status(404).json({ message: "You don't have enough turns to roll." });
                };

                return;
            };

            throw Error("Query is not acknowledged");
        } catch (error) {
            console.error(error);
            // await session.abortTransaction();
            res.status(500).json({ message: 'Internal server error' });
        } finally {
            // await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
};