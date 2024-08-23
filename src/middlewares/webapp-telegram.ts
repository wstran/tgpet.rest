import { Request, Response, NextFunction } from 'express';
import CryptoJS, { enc, MD5 } from 'crypto-js';
import Database from '../libs/database';
import { RedisWrapper } from '../libs/redis-wrapper';
import { generateRandomUpperString } from '../libs/custom';
import geoip from 'geoip-lite';

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

    const secretKey = CryptoJS.HmacMD5(process.env.BOT_TOKEN as string, 'WebAppData');

    const webapp_init = req.headers['--webapp-init'];

    const webapp_hash = req.headers['--webapp-hash'];

    if (typeof webapp_init !== 'string' || typeof webapp_hash !== 'string') {
        return res.status(400).json({ message: 'Bad request.' });
    };

    const [timestamp, request_hash] = webapp_hash.split(':');

    if (typeof timestamp !== 'string' || typeof request_hash !== 'string') {
        return res.status(400).json({ message: 'Bad request.' });
    };

    const now_date = new Date();

    if (Number(timestamp) + 1000 < now_date.getTime()) {
        return res.status(400).json({ message: 'Bad request.' });
    };

    let dataToSign = `timestamp=${timestamp}&initData=${webapp_init}`;

    if (req.method === 'GET' && req.query) {
        const params = new URLSearchParams(req.query as any).toString();
        dataToSign += `&params=${params}`;
    };

    if (req.method === 'POST' && req.body) {
        const data = JSON.stringify(req.body);
        dataToSign += `&data=${data}`;
    };

    const serverSignature = MD5(process.env.ROOT_SECRET + dataToSign).toString(enc.Hex);

    if (serverSignature !== request_hash) {
        return res.status(400).json({ message: 'Bad request.' });
    };

    const params = new URLSearchParams(decodeURIComponent(webapp_init));

    const hash = params.get('hash');

    params.delete('hash');

    const dataCheckString = Array.from(params.entries()).sort().map(e => `${e[0]}=${e[1]}`).join('\n');

    const hmac = CryptoJS.HmacMD5(dataCheckString, secretKey).toString(CryptoJS.enc.Hex);

    if (hmac !== hash) {
        return res.status(403).json({ message: 'Invalid user data.' });
    };

    const user_param = params.get('user');

    const auth_date = Number(params.get('auth_date')) * 1000;

    if (typeof user_param !== 'string' || isNaN(auth_date)) {
        return res.status(400).json({ message: 'Bad request.' });
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

    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!ip) return res.status(400).json({ message: 'Bad request.' });

    if (Array.isArray(ip)) ip = ip[0];

    const lookup = geoip.lookup(ip);

    if (lookup === null) return res.status(400).json({ message: 'Bad request.' });

    const formattedLocation = {
        ip_address: ip,
        country_code: lookup.country,
        region_code: lookup.region,
        city_name: lookup.city,
        latitude: lookup.ll[0],
        longitude: lookup.ll[1],
        timezone: lookup.timezone || 'Unknown'
    };

    const dbInstance = Database.getInstance();
    const db = await dbInstance.getDb();
    const client = dbInstance.getClient();
    const userCollection = db.collection('users');
    const locationCollection = db.collection('locations');

    const session = client.startSession({ 
        defaultTransactionOptions: { 
            readConcern: { level: 'local' }, 
            writeConcern: { w: 1 }, 
            retryWrites: false 
        } 
    });

    try {
        await session.withTransaction(async () => {
            const referral_code = params.get('start_param');

            const insert: { created_at?: Date; invite_code?: string; referral_code?: string } = {};

            const is_new = await userCollection.countDocuments({ tele_id }, { session }) === 0;

            while (is_new) {
                const generate_invite = generateRandomUpperString(8);

                if (generate_invite !== referral_code && await userCollection.countDocuments({ invite_code: generate_invite }, { session }) === 0) {
                    insert.created_at = now_date;
                    insert.invite_code = generate_invite;

                    if (typeof referral_code === 'string') {
                        const is_invite_code_valid = await userCollection.countDocuments({ invite_code: referral_code }, { session }) === 1;

                        if (is_invite_code_valid) insert.referral_code = referral_code;
                    };
                    break;
                };
            };

            const update_user_result = await userCollection.findOneAndUpdate(
                { tele_id },
                {
                    $set: { 
                        name: user.name, 
                        username: user.username, 
                        auth_date: user.auth_date, 
                        last_active: now_date, 
                        ip_location: formattedLocation 
                    },
                    $setOnInsert: insert,
                },
                { 
                    upsert: true, 
                    returnDocument: 'before', 
                    projection: { _id: 0, 'ip_location.ip_address': 1 },
                    session 
                }
            );

            const previous_ip = update_user_result?.value?.ip_location?.ip_address;

            const update_location_result = await locationCollection.updateOne(
                { 
                    tele_id, 
                    ip_address: ip, 
                    ...(previous_ip !== ip && { upsert: session.id?.id.toString('hex') }) 
                },
                {
                    $set: { ...formattedLocation, last_active: now_date },
                    $setOnInsert: { tele_id, ...formattedLocation, created_at: now_date },
                },
                { upsert: true, session }
            );

            if (update_user_result === null && update_location_result.acknowledged === true) {
                await session.commitTransaction();

                return next();
            }
        });
    } catch (error) {
        console.error(error);
        await redisWrapper.delete(REDIS_KEY, REDIS_VALUE);
        res.status(500).json({ message: 'Internal server error.' });
    } finally {
        await session.endSession();
    };
};