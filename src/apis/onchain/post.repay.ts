import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { Address, toNano } from '@ton/core';
import { CONFIG } from '../../config';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    router.post('/onchain/repay', Middleware, async (req, res) => {
        const { amount, address } = req.body;

        if (
            typeof amount !== 'number' ||
            isNaN(amount) || amount <= 0
            || amount > 5000000000 ||
            Address.isFriendly(address) === false
        ) {
            res.status(400).json({ message: 'Bad request.' });
            return;
        };

        const { tele_user } = req as RequestWithUser;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');
        const todoCollection = db.collection('todos');

        const session = client.startSession({
            defaultTransactionOptions: {
                readConcern: { level: 'local' },
                writeConcern: { w: 1 },
                retryWrites: false
            }
        });

        try {
            await session.withTransaction(async () => {
                const get_repay = await userCollection.findOne(
                    { tele_id: tele_user.tele_id },
                    { projection: { username: 1, is_repaying: 1, "balances.tgpet": 1, ton_mortgage_amount: 1, tgpet_borrowed_amount: 1 }, session }
                );

                if (!get_repay) {
                    res.status(404).json({ message: 'User not found or not eligible for repayment.' });
                    throw new Error('Transaction aborted: User not found or not eligible for repayment.');
                };

                if (get_repay.is_repaying) {
                    res.status(404).json({ message: 'You are already repaying.' });
                    throw new Error('Transaction aborted: User is already repaying.');
                };

                if ((get_repay.balances.tgpet || 0) < amount) {
                    res.status(404).json({ message: 'You do not have enough TGPET.' });
                    throw new Error('Transaction aborted: Insufficient TGPET balance.');
                };

                if ((get_repay.tgpet_borrowed_amount || 0) < amount) {
                    res.status(404).json({ message: 'You do not have enough borrowed TGPET.' });
                    throw new Error('Transaction aborted: Insufficient borrowed TGPET.');
                };

                const created_at = new Date();

                const conversion_value = get_repay.ton_mortgage_amount / get_repay.tgpet_borrowed_amount;
                const repay_ton_amount = amount * conversion_value;
                const onchain_amount = toNano(repay_ton_amount - 0.008).toString();

                const repay_config = CONFIG.GET('repay_state');

                const [update_user_result, add_todo_result, add_message_result] = await Promise.all([
                    userCollection.updateOne(
                        {
                            tele_id: tele_user.tele_id,
                            "balances.tgpet": { $gte: amount },
                            ton_mortgage_amount: { $gte: repay_ton_amount },
                            tgpet_borrowed_amount: { $gte: amount },
                        },
                        {
                            $set: { is_repaying: true },
                            $inc: {
                                "balances.tgpet": -amount,
                                ton_mortgage_amount: -repay_ton_amount,
                                tgpet_borrowed_amount: -amount,
                                ...(repay_config.state !== 'approve' && { "totals.tgpet_repayed_amount": amount }),
                            },
                        },
                        { session }
                    ),
                    todoCollection.updateOne(
                        { todo_type: 'rest:onchain/repay', tele_id: tele_user.tele_id, status: 'pending' },
                        {
                            $setOnInsert: {
                                todo_type: 'rest:onchain/repay',
                                tele_id: tele_user.tele_id,
                                status: repay_config.state === 'approve' ? 'approving' : 'pending',
                                address: address,
                                amount: amount,
                                repay_ton_amount,
                                onchain_amount,
                                session_id: session.id,
                                created_at,
                            },
                        },
                        { upsert: true, session }
                    ),

                    repay_config.state === 'approve' && todoCollection.insertOne({
                        todo_type: 'bot:send/tele/message',
                        tele_id: tele_user.tele_id,
                        status: "pending",
                        is_admin: true,
                        session_id: session.id,
                        target_id: '-1002199986770',
                        message: `A user has requested to repay their TGPET loan. Please approve or reject the request.\n\nRepay:\n**tele_id: ** \`\${tele_user.tele_id}\`\\n**username: ** @${get_repay.username || 'Unknown'}\n**tgpet_amount: ** ${amount}\n**repay_ton_amount: ** ${repay_ton_amount}`,
                        buttons: [
                            {
                                "text": "Approve",
                                "callback_data": "approve_repay_" + session.id
                            },
                            {
                                "text": "Reject",
                                "callback_data": "reject_repay_" + session.id
                            }
                        ],
                        created_at,
                    }),
                ]);

                if (add_todo_result.upsertedCount > 0 && update_user_result.modifiedCount > 0 && (!add_message_result || add_message_result.acknowledged === true)) {
                    res.status(200).json({ repay_ton_amount, created_at });
                } else {
                    res.status(500).json({ message: 'Transaction failed to commit.' });
                    throw new Error('Transaction failed to commit.');
                };
            });
        } catch (error) {
            if (!res.headersSent) {
                console.error(error);
                res.status(500).json({ message: 'Internal server error.' });
            };
        } finally {
            await session.endSession();
            await redisWrapper.delete(REDIS_KEY, tele_user.tele_id);
        };
    });
}