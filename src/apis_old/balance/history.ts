import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';

const allow_history_types = new Map([
    ['claim', 'claim_balance'],
    ['convert', 'convert_balance'],
]);

export default function (router: Router) {
    router.get("/balance/history", Middleware, async (req, res) => {
        const { history_type } = req.query as { history_type: string };

        const get_history_type = allow_history_types.get(history_type);

        if (typeof history_type !== 'string' || !get_history_type) {
            res.status(401).json({ message: 'Bad request.' });
            return;
        };

        const tele_user = (req as RequestWithUser).tele_user;

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const todoCollection = db.collection("todos");

        try {
            const history_result = await todoCollection
                .find({ todo_type: get_history_type, tele_id: tele_user.tele_id, status: 'success' })
                .project({ _id: 0, amount: 1, created_at: 1 })
                .sort({ created_at: -1 })
                .toArray();

            res.status(200).json(history_result);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: 'Internal server error' });
        };
    });
};