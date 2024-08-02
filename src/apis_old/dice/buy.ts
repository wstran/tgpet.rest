// import { Router } from 'express';
// import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
// import Database from '../../libs/database';
// import { RedisWrapper } from '../../libs/redis-wrapper';
// // import { getRandomInt } from '../../libs/custom';

// const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

// const REDIS_KEY = 'LOTTEFI_API';

// const shops = [
//     { xlotp: 1, roll_amount: 1 },
//     { xlotp: 10, roll_amount: 10 },
//     { xlotp: 30, roll_amount: 30 },
//     { xlotp: 100, roll_amount: 100 },
//     { xlotp: 200, roll_amount: 200 },
// ];

// export default function (router: Router) {
//     router.post("/dice/buy", Middleware, async (req, res) => {
//         const { pack_id, sign } = req.body;

//         if (typeof pack_id !== 'number') {
//             res.status(401).json({ message: 'Bad request.' });
//             return;
//         };

//         const tele_user = (req as RequestWithUser).tele_user;

//         if (typeof sign === 'string' && sign.length !== 22) {
//             res.status(401).json({ message: 'Bad request.' });
//             await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15);
//             return;
//         };

//         if (await redisWrapper.has(REDIS_KEY, tele_user.tele_id)) {
//             res.status(429).json({ message: 'Too many requests.' });
//             return;
//         };

//         await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15);

//         const dbInstance = Database.getInstance();
//         const db = await dbInstance.getDb();
//         // const client = dbInstance.getClient();
//         const logCollection = db.collection("logs");
//         const userCollection = db.collection("users");
//         const metadataCollection = db.collection("metadata");

//         // const session = client.startSession();

//         try {
//             // session.startTransaction();
//             const shop = shops[pack_id];

//             if (shop) {
//                 const result = await userCollection.updateOne({ tele_id: tele_user.tele_id, ...(!sign && { 'balances.xlotp': { $gte: shop.xlotp } }) }, { $inc: { ...(sign ? ({ total_roll_amount_ton: shop.roll_amount }) : ({ 'balances.xlotp': -shop.xlotp })), roll_amount: shop.roll_amount, total_roll_amount: shop.roll_amount } });

//                 if (result.acknowledged === true && result.modifiedCount > 0) {
//                     await Promise.all([
//                         metadataCollection.updateOne({ meta_id: 'dice_roll' }, { $setOnInsert: { meta_id: 'dice_roll' }, $inc: { ...(sign && ({ total_roll_amount_ton: shop.roll_amount })), current_roll_amount: shop.roll_amount, total_roll_amount: shop.roll_amount } }, { upsert: true }),
//                         logCollection.insertOne({ type: 'dice_buy', ...(sign && { sign }), tele_id: tele_user.tele_id, ...shop, created_at: new Date() }),
//                     ]);

//                     res.status(200).json(shop);
//                     return;
//                 } else {
//                     res.status(404).json({ message: "You don't have enough turns to roll." });
//                 };
//             };

//             throw Error("Query is not acknowledged");
//         } catch (error) {
//             console.error(error);
//             // await session.abortTransaction();
//             res.status(500).json({ message: 'Internal server error' });
//         } finally {
//             // await session.endSession();
//             await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
//         };
//     });
// };