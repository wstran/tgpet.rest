import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { ObjectId } from 'mongodb';
import { roundDown } from '../../libs/custom';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const REDIS_KEY = 'TPET_API';

interface Pet {
    _id: ObjectId,
    tele_id: string,
    farm_at?: Date,
    mana: Date,
}

/* const caculateFarmBoost = (
    current_time: number,
    farm_at: number,
    boosts: { percent: number; start_at: string; end_at: string }[],
    config_level: Level
): number => {
    let boost_balance = 0;

    for (let i = 0; i < boosts.length; ++i) {
        const start_at = Date.parse(boosts[i].start_at);
        const end_at = Date.parse(boosts[i].end_at);

        if (current_time >= start_at) {
            if (current_time < end_at) {
                const current_balance =
                    ((current_time - farm_at) / 1000 / 60) * config_level.base_speed;

                boost_balance +=
                    current_balance > 0
                        ? (current_balance / 100) * boosts[i].boost_percent
                        : 0;
            };
        };
    };

    return boost_balance
}; */

/* function caculateFarmBoost(boosts: { count: number, date: Date }) {
    if (!boosts) return null;

    const currentDate = new Date();

    const sortedKeys = Object.keys(CONFIG_BOOSTS).map(Number).sort((a, b) => a - b);

    for (let i = 0; i < sortedKeys.length; i++) {
        if (boosts.count < sortedKeys[i]) {
            const data = CONFIG_BOOSTS[sortedKeys[i - 1]];

            return (data && ((currentDate.getTime() - boosts.date.getTime()) / (24 * 60 * 60 * 1000)) < data.day) ? data.boost : null;
        };
    };

    return CONFIG_BOOSTS[sortedKeys[sortedKeys.length - 1]].boost;
}; */

// DEV
const caculateFarmAmount = (pets: Pet[]): [number, ObjectId[]] => {
    const boost_config = CONFIG.GET('boost');

    let total_amount = 0;
    const pet_ids: ObjectId[] = [];

    for (let i = 0; i < pets.length; ++i) {

    };

    return [Number(roundDown(total_amount, 2)), pet_ids];
}

export default function (router: Router) {
    router.post("/game/claim", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection("users");
        const petCollection = db.collection("pets");
        const logCollection = db.collection("logs");

        const session = client.startSession({ causalConsistency: true });

        try {
            session.startTransaction({ willRetryWrite: true });

            const pets = await petCollection.find({ tele_id: tele_user.tele_id }, { session }).toArray() as Pet[];

            const [farm_points, pet_ids] = caculateFarmAmount(pets);

            if (farm_points > 0 && pet_ids.length > 0) {
                const now_date = new Date();

                const [update_user_result, update_pet_result, insert_log_result] = await Promise.all([
                    userCollection.updateOne({ tele_id: tele_user.tele_id }, { $inc: { 'balances.tgp': farm_points } }, { session }),
                    petCollection.updateMany({ _id: { $in: pet_ids } }, { $set: { farm_at: now_date, farm_balance: 0 } }, { session }),
                    logCollection.insertOne({ log_type: 'game/claim', tele_id: tele_user.tele_id, farm_points, created_at: now_date, pet_ids, pets_before: pets }, { session })
                ]);

                if (
                    update_user_result.acknowledged === true && update_user_result.modifiedCount > 0 &&
                    update_pet_result.acknowledged === true && update_pet_result.modifiedCount > 0 &&
                    insert_log_result.acknowledged === true
                ) {
                    await session.commitTransaction();
                };
            };

            res.status(200).json({ farm_points });
        } catch (error) {
            await session.abortTransaction();
            res.status(500).json({ message: 'Internal server error.' });
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}