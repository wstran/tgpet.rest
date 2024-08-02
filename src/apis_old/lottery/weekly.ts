/* import { Router } from 'express';
import CryptoJS from 'crypto-js';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { transfer_to_admin } from '../../libs/blast';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const REDIS_KEY = 'LOTTEFI_API';

const ticket_type: 'weekly' = 'weekly';

const types = ['buy_ticket'];

function getMondayOfCurrentWeek() {
    const date = new Date();
    const day = date.getUTCDay();
    const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
    date.setUTCHours(0, 0, 0, 0);
    return new Date(date.setUTCDate(diff));
};

export default function (router: Router) {
    router.post("/lottery/weekly", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        const { type, amount } = req.body;

        if (typeof type !== 'string' || typeof amount !== 'number' || (amount < 1 || amount > 2000) || !types.includes(type)) {
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
        const userCollection = db.collection('users');
        const configCollection = db.collection('config');
        const lotteryTicketCollection = db.collection('lottery_tickets');
        const lotteryPoolCollection = db.collection('lottery_pools');

        if (type === 'buy_ticket') {
            const session = client.startSession();

            try {
                session.startTransaction();

                const [user, config] = await Promise.all([
                    userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, wallet: 1 } }),
                    configCollection.findOne({ config_type: 'lottery' }, { projection: { _id: 0, weekly: 1 } }),
                ]);

                if (user === null) {
                    res.status(403).json({ message: 'Invalid user data' });
                    return;
                };

                if (config === null) {
                    res.status(404).json({ message: 'Invalid server data' });
                    return;
                };

                const utc_date = new Date();

                const day_of_week = utc_date.getUTCDay();

                const utc_hours = utc_date.getUTCHours();

                if ((day_of_week === 0 && utc_hours >= 23) || (day_of_week === 1 && utc_hours < 1)) {
                    res.status(404).json({ message: 'Time to buy tickets has expired', reason: 'Time to buy tickets has expired' });
                    return;
                };

                const created_at = new Date();

                const ticket_time = getMondayOfCurrentWeek();

                const tickets = [];

                const floor_amount = Math.floor(amount);

                for (let i = 0; i < floor_amount; i++) {
                    tickets.push({
                        address: user.wallet.address,
                        ticket_type: ticket_type,
                        ticket_time: ticket_time,
                        status: 'pending',
                        created_at: created_at,
                    });
                };

                const insert_tickets = await lotteryTicketCollection.insertMany(tickets, { session });

                if (insert_tickets.acknowledged === true) {
                    const ticket_values = Object.values(insert_tickets.insertedIds);

                    const pool_result = await lotteryPoolCollection.bulkWrite(ticket_values.map(insertedId => ([
                        {
                            updateOne: {
                                filter: { pool_type: ticket_type, pool_time: ticket_time, status: 'processing' },
                                update: {
                                    $addToSet: { pool_tickets: { ticket_id: insertedId.toHexString(), address: user.wallet.address, created_at } },
                                },
                            }
                        },
                        {
                            updateOne: {
                                filter: { pool_type: ticket_type, pool_time: ticket_time, status: 'processing', 'user_tickets.address': user.wallet.address },
                                update: {
                                    $inc: { 'user_tickets.$.total_tickets': 1 }
                                },
                            }
                        },
                        {
                            updateOne: {
                                filter: { pool_type: ticket_type, pool_time: ticket_time, status: 'processing', 'user_tickets.address': { $ne: user.wallet.address } },
                                update: {
                                    $addToSet: { user_tickets: { address: user.wallet.address, total_tickets: 1, created_at } },
                                },
                            }
                        },
                    ])).flatMap(i => i), { session });

                    if (pool_result.modifiedCount > 0) {
                        const private_key = CryptoJS.AES.decrypt(user.wallet.private_key, process.env.SECRET_KEY!).toString(CryptoJS.enc.Utf8);

                        const transaction_receipt = await transfer_to_admin(private_key, (Number(config.weekly.ticket_cost) * ticket_values.length).toString());

                        if (transaction_receipt.status === 1) {
                            await Promise.all([
                                lotteryTicketCollection.bulkWrite(ticket_values.map((insertedId, index) => ({
                                    updateOne: {
                                        filter: { _id: insertedId },
                                        update: { $set: { ticket_id: `${transaction_receipt.hash}_${index}`, status: 'success', transaction_receipt, success_at: new Date() } },
                                    }
                                })), { session }),
                                lotteryPoolCollection.bulkWrite(ticket_values.map((insertedId, index) => ({
                                    updateOne: {
                                        filter: { pool_type: ticket_type, pool_time: ticket_time },
                                        update: {
                                            $set: { 'pool_tickets.$[elem].ticket_id': `${transaction_receipt.hash}_${index}` }
                                        },
                                        arrayFilters: [{ 'elem.ticket_id': insertedId.toHexString() }],
                                    }
                                })), { session }),
                                userCollection.updateOne({ tele_id: tele_user.tele_id }, { $inc: { total_bought_weekly_tickets: ticket_values.length } }),
                            ]);

                            await session.commitTransaction();

                            res.status(200).send('ok');
                        };

                        return;
                    };
                };

                throw Error('Query is not acknowledged');
            } catch (error) {
                console.error(error);
                await session.abortTransaction();
                res.status(500).json({ message: 'Internal server error', reason: (error as any)?.reason });
            } finally {
                await session.endSession();
                await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
            };
        };
    });
}; */