import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';

export default function (router: Router) {
    router.get('/self/referral', Middleware, async (req, res) => {
        /* const { page, limit } = req.query;

        if (typeof page !== 'number' || typeof limit !== 'number' || page < 1 || limit < 1 || limit > 10) {
            return res.status(400).json({ message: 'Bad request.' });
        }; */

        const { tele_user } = req as RequestWithUser;

        try {
            const dbInstance = Database.getInstance();
            const db = await dbInstance.getDb();
            const userCollection = db.collection('users');

            const user = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, invite_code: 1 } });

            if (user === null) {
                return res.status(404).json({ message: 'Not found.' });
            };

            const user_refs = await userCollection.find({ referral_code: user.invite_code }).project({ _id: 0, name: 1, username: 1, 'totals.referral_points': 1, created_at: 1 })/* .skip(page).limit(limit) */.toArray();

            return res.status(200).json(user_refs);
        } catch {
            return res.status(500).json({ message: 'Internal server error.' });
        };
    });
}