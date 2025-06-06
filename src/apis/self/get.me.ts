import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { CONFIG } from '../../config';

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

const not_allows = ['wallet'];

export default function (router: Router) {
    router.get('/self/me', Middleware, async (req, res) => {
        const { tele_user } = req as RequestWithUser;

        try {
            const dbInstance = Database.getInstance();
            const db = await dbInstance.getDb();
            const userCollection = db.collection('users');

            const { user_project, config_project, config_only }: { user_project: string, config_project: string, config_only: boolean } = req.query as any;

            let user: User | null = null;

            if (!config_only) {
                const user_projection = user_project && user_project.split(' ');

                user = await userCollection.findOne(
                    { tele_id: tele_user.tele_id },
                    {
                        projection: {
                            _id: 0,
                            ...(
                                user_project === '*' || user_projection.length === 0
                                    ?
                                    not_allows.reduce((prev, current) => ({ ...prev, [current]: 0 }), {})
                                    :
                                    (user_projection && user_projection.reduce((prev, current) => not_allows.includes(current) ? prev : ({ ...prev, [current]: 1 }), {}))
                            )
                        }
                    }) as User | null;

                if (user === null && process.env.NODE_ENV !== 'development') {
                    return res.status(403).json({ message: 'Invalid user data.' });
                };
            };

            let config = (config_project === '*' ? CONFIG.config : config_project?.split(' ').map(i => CONFIG.GET(i))) as Config[];

            const results: { config?: Config[], user?: User } = {};

            if (user) results.user = user;

            if (config) results.config = config;

            return res.status(200).json(results);
        } catch (error) {
            return res.status(500).json({ message: 'Internal server error.' });
        };
    });
}