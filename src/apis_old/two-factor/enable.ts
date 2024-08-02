import { Router } from 'express';
import Middleware, { RequestWithUser } from '../../middlewares/webapp-telegram';
import Database from '../../libs/database';
import { authenticator } from 'otplib';
import { symmetricDecrypt } from '../../libs/crypto';

export default function (router: Router) {
    router.post("/two-factor/enable", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        const { totp_code } = req.body;

        if (typeof totp_code !== 'string' || totp_code.length !== 6) {
            res.status(401).json({ message: 'Bad Request' });
            return;
        };

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const client = dbInstance.getClient();
        const userCollection = db.collection('users');

        const session = client.startSession();

        try {
            session.startTransaction();

            const user = await userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { two_factor_enabled: 1, two_factor_secret: 1 } });
            
            if (user === null) {
                res.status(403).json({ message: 'Invalid user data' });
                return;
            };

            if (user.two_factor_enabled === true) {
                res.status(400).json({ message: 'Two factor already enabled' });
                return;
            };
    
            if (!user.two_factor_secret) {
                res.status(400).json({ message: 'Two factor setup required' });
                return;
            };

            const secret = symmetricDecrypt(user.two_factor_secret, process.env.ENCRYPTION_KEY!);

            if (secret.length !== 32) {
                throw Error('Two factor secret decryption failed');
            };

            const is_valid_token = authenticator.check(totp_code, secret);

            if (!is_valid_token) {
                res.status(400).json({ message: 'Incorrect two factor code' });
                return;
            };

            const result = await userCollection.updateOne(
                { tele_id: tele_user.tele_id },
                {
                    $set: { two_factor_enabled: true },
                },
                { session }
            );

            if (result.acknowledged === true) {
                await session.commitTransaction();

                res.status(200).send('ok');

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