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

const not_allows = ['wallet'];

export default function (router: Router) {
    router.get('/self/me', Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        try {
            const dbInstance = Database.getInstance();
            const db = await dbInstance.getDb();
            const configCollection = db.collection('config');
            const userCollection = db.collection('users');

            const { user_project, config_project }: { user_project: string, config_project: string } = req.query as any;

            const result_promise = [];

            const user_projection = user_project && user_project.split(' ');

            result_promise.push(
                userCollection.findOne(
                    { tele_id: tele_user.tele_id },
                    {
                        projection: {
                            _id: 0,
                            ...(
                                user_projection.length === 0
                                    ?
                                    not_allows.reduce((prev, current) => ({ ...prev, [current]: 0 }), {})
                                    :
                                    (user_projection && user_projection.reduce((prev, current) => not_allows.includes(current) ? prev : ({ ...prev, [current]: 1 }), {}))
                            )
                        }
                    })
            );

            if (config_project) {
                result_promise.push(configCollection.find({ ...((config_project && config_project !== '*') && { config_type: { $in: config_project.split(' ') } }) }).project({ _id: 0 }).toArray());
            };

            const [user, config]: [User, Config | undefined] = await Promise.all(result_promise) as any;

            if (user === null) {
                res.status(403).json({ message: 'Invalid user data.' });
                return;
            };

            const results: { config?: Config, user: User } = { user };

            if (config) results.config = config;

            res.status(200).json(results).end();
        } catch (error) {
            res.status(500).json({ message: 'Internal server error.' });
        };
    });
}