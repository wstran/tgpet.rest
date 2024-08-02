import { Request, Response, NextFunction } from 'express';
import CryptoJS from 'crypto-js';
import Database from '../libs/database';
import { RedisWrapper } from '../libs/redis-wrapper';
import { generateRandomUpperString } from 'libs/custom';

export interface User {
    tele_id: string;
    name: string;
    username: string;
    auth_date: Date;
};

interface TeleUser extends User {
    hash: string;
};

export interface RequestWithUser extends Request {
    tele_user: TeleUser;
};

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

export default async function (req: Request, res: Response, next: NextFunction) {
    if (process.env.NODE_ENV === 'development') {
        const user = { tele_id: '1853181392' } as User;

        (req as RequestWithUser).tele_user = { ...user, hash: '0x' };

        return next();
    };

    const secretKey = CryptoJS.HmacSHA256(process.env.BOT_TOKEN as string, 'WebAppData');

    const params = new URLSearchParams(decodeURIComponent(req.headers['--webapp-init'] as string));

    const hash = params.get('hash');

    params.delete('hash');

    const dataCheckString = Array.from(params.entries()).sort().map(e => `${e[0]}=${e[1]}`).join('\n');

    const hmac = CryptoJS.HmacSHA256(dataCheckString, secretKey).toString(CryptoJS.enc.Hex);

    if (hmac !== hash) {
        res.status(403).json({ message: 'Invalid user data.' });
        return;
    };

    const user_param = params.get('user');

    const auth_date = Number(params.get('auth_date')) * 1000;

    if (typeof user_param !== 'string' || isNaN(auth_date)) {
        res.status(400).json({ message: 'Bad request.' });
        return;
    };

    const parse_user = JSON.parse(user_param);

    const tele_id = String(parse_user.id);

    const user = {
        tele_id,
        name: [parse_user.first_name, parse_user.last_name || ''].join(' '),
        username: parse_user.username,
        auth_date: new Date(auth_date),
    } as User;

    (req as RequestWithUser).tele_user = { ...user, hash };

    const [REDIS_KEY, REDIS_VALUE] = ['AUTH_CACHE', tele_id];

    const acquired = await redisWrapper.add(REDIS_KEY, REDIS_VALUE, 60 * 5);

    if (!acquired) return next();

    const dbInstance = Database.getInstance();
    const db = await dbInstance.getDb();
    const client = dbInstance.getClient();
    const userCollection = db.collection('users');

    const session = client.startSession();

    try {
        session.startTransaction();

        const referral_code = params.get('start_param');

        const insert: { created_at?: Date; invite_code?: string; referral_code?: string } = {};

        const is_new = await userCollection.countDocuments({ tele_id }) === 0;

        const now_date = new Date();

        while (is_new) {
            const generate_invite = generateRandomUpperString(8);

            if (generate_invite !== referral_code && await userCollection.countDocuments({ invite_code: generate_invite }) === 0) {

                insert.created_at = now_date;
                insert.invite_code = generate_invite;

                if (typeof referral_code === 'string') {
                    const result = await userCollection.updateOne(
                        { invite_code: referral_code, 'user_refs.tele_id': { $ne: tele_id } },
                        {
                            $addToSet: { user_refs: { tele_id, created_at: now_date } },
                        },
                        { session }
                    );

                    if (result.acknowledged === true && result.modifiedCount > 0) {
                        insert.referral_code = referral_code;
                    };
                };
                break;
            };
        };

        const result = await userCollection.updateOne(
            { tele_id },
            {
                $set: { name: user.name, username: user.username, auth_date: user.auth_date, last_active: now_date },
                $setOnInsert: insert,
            },
            { upsert: true, session }
        );

        if (result.acknowledged === true) {
            await session.commitTransaction();

            return next();
        };
    } catch (error) {
        console.error(error);
        await session.abortTransaction();
        await redisWrapper.delete(REDIS_KEY, REDIS_VALUE);
        res.status(500).json({ message: 'Internal server error.' });
    } finally {
        await session.endSession();
    };
};