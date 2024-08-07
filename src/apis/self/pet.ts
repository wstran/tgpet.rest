import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';

export interface Config {
    config_type: string;
    [key: string]: any;
};

export interface User {
    tele_id: string;
    name: string;
    username: string | null;
    invite_code: string;
    referral_code: string;
};

export default function (router: Router) {
    router.get('/self/pet', Middleware, async (req, res) => {
        const { tele_user } = req as RequestWithUser;

        const { page, limit } = req.params;

        if (typeof page !== 'number' || typeof limit !== 'number' || page < 1 || limit < 1 || limit > 10) {
            return res.status(400).json({ message: 'Bad request.' });
        };

        try {
            const dbInstance = Database.getInstance();
            const db = await dbInstance.getDb();
            const petCollection = db.collection('pets');

            const pets = await petCollection.find({ tele_id: tele_user.tele_id }).skip(page).limit(limit).toArray();

            return res.status(200).json(pets);
        } catch (error) {
            return res.status(500).json({ message: 'Internal server error.' });
        };
    });
}