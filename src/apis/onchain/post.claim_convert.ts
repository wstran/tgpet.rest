import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { RedisWrapper } from '../../libs/redis-wrapper';
import { CONFIG } from '../../config';
import { ObjectId } from 'mongodb';

const redisWrapper = new RedisWrapper(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const REDIS_KEY = 'TPET_API';

export default function (router: Router) {
    /* router.post('/onchain/claim_convert', Middleware, async (req, res) => {
        const { convert_id } = req.body;

        if (typeof convert_id !== 'string') {
            res.status(400).json({ message: 'Bad request.' });
            return;
        };

        const { tele_user } = req as RequestWithUser;

        if (!await redisWrapper.add(REDIS_KEY, tele_user.tele_id, 15)) {
            res.status(429).json({ message: 'Too many requests.' });
            return;
        };

        const convert_sets = CONFIG.GET('convert_sets');

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
                const [user, todo] = await Promise.all([
                    userCollection.findOne(
                        { tele_id: tele_user.tele_id },
                        { projection: { _id: 0, balances: 1 }, session }
                    ),
                    todoCollection.findOne(
                        { _id: new ObjectId(convert_id), tele_id: tele_user.tele_id, todo_type: 'rest:onchain/convert', convert_type: 'tgp_to_tgpet', status: 'pending' },
                        { projection: { _id: 0, convert_type: 1, amount: 1, created_at: 1 }, session }
                    )
                ]);

                if (user == null) {
                    res.status(404).json({ message: 'User not found.' });
                    throw new Error('Transaction aborted: User not found.');
                };

                if (todo == null) {
                    res.status(404).json({ message: 'Convert not found.' });
                    throw new Error('Transaction aborted: Convert not found.');
                };

                const created_at = new Date();

                const can_claim = todo.created_at.getTime() + (convert_sets[todo.convert_type].pending || 0) < created_at.getTime();

                if (!can_claim) {
                    res.status(404).json({ message: 'Convert is not ready to claim.' });
                    throw new Error('Transaction aborted: Convert is not ready to claim.');
                };

                const [update_todo_result, update_user_result] = await Promise.all([
                    todoCollection.updateOne(
                        { _id: new ObjectId(convert_id), tele_id: tele_user.tele_id, todo_type: 'rest:onchain/convert', convert_type: 'tgp_to_tgpet', status: 'pending' },
                        { $set: { status: 'completed', completed_at: created_at } },
                        { session }
                    ),
                    userCollection.updateOne(
                        { tele_id: tele_user.tele_id },
                        { $inc: { [`balances.${convert_sets[todo.convert_type].to}`]: todo.amount } },
                        { session }
                    ),
                ]);

                if (update_todo_result.modifiedCount > 0 && update_user_result.modifiedCount > 0) {
                    res.status(200).json({ amount: todo.amount });
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
    }); */
}