import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { symmetricEncrypt } from '../../libs/crypto';
import { authenticator } from 'otplib';
import { toBase64 } from '../../libs/base64';

export default function (router: Router) {
    router.post("/two-factor/setup", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');

        const session = client.startSession();

        try {
            session.startTransaction();

            const user = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { name: 1, two_factor_enabled: 1 } });

            if (user === null) {
                res.status(403).json({ message: 'Invalid user data' });
                return;
            };

            if (user.two_factor_enabled === true) {
                res.status(400).json({ message: 'Two factor already enabled' });
                return;
            };

            const secret = authenticator.generateSecret(20);

            const result = await userCollection.updateOne(
                { tele_id: tele_user.tele_id },
                {
                    $set: {
                        two_factor_enabled: false,
                        two_factor_secret: symmetricEncrypt(secret, process.env.ENCRYPTION_KEY!),
                    },
                },
                { session }
            );

            if (result.acknowledged === true) {
                await session.commitTransaction();

                const name = user.name as string;

                const keyUri = authenticator.keyuri(name, 'LotteFi', secret);

                res.status(200).json(toBase64({ secret, keyUri }));

                return;
            };

            throw Error('Query is not acknowledged');
        } catch (error) {
            console.error(error);
            await session.abortTransaction();
            res.status(500).json({ message: 'Internal server error' });
        } finally {
            await session.endSession();
        };
    });
};