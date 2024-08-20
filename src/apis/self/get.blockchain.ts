import { Router, Request, Response } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';

const allow_history_types = new Map([
    ['onchain/borrow', { _id: 0, amount: 1, tgpet_amount: 1, status: 1, created_at: 1 }],
    ['onchain/repay', { _id: 0, amount: 1, repay_ton_amount: 1, status: 1, created_at: 1 }],
    ['onchain/convert', { _id: 1, amount: 1, status: 1, convert_type: 1, created_at: 1 }],
]);

export default function (router: Router) {
    router.get("/self/onchain", Middleware, async (req: Request, res: Response) => {
        const { history_type } = req.query as { history_type: string };

        const get_history_project = allow_history_types.get(history_type);

        if (typeof history_type !== 'string' || !get_history_project) {
            return res.status(401).json({ message: 'Bad request.' });
        }

        const { tele_user } = req as RequestWithUser;

        try {
            const dbInstance = Database.getInstance();
            const db = await dbInstance.getDb();
            const todoCollection = db.collection("todos");

            const history_result = await todoCollection
                .find({ todo_type: 'rest:' + history_type, tele_id: tele_user.tele_id })
                .project(get_history_project)
                .sort({ created_at: -1 })
                .toArray();

            return res.status(200).json(history_result);
        } catch {
            return res.status(500).json({ message: 'Internal server error' });
        }
    });
};
