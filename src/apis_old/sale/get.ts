import { Router } from "express";
import Middleware, { RequestWithUser } from "../../middlewares/webapp-telegram";
import Database from "../../libs/database";

export default function (router: Router) {
    router.get("/sale/get", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        try {
            const dbInstance = Database.getInstance();
            const db = await dbInstance.getDb();
            const userCollection = db.collection("users");
            const todoCollection = db.collection("todos");
            const metadataCollection = db.collection("metadata");

            const [historys, contributors, meta, user, total_participant] = await Promise.all([
                todoCollection
                    .find({ todo_type: 'sale_balance', tele_id: tele_user.tele_id, status: 'success' })
                    .project({ _id: 0, ton_amount: 1, created_at: 1 })
                    .sort({ created_at: -1 })
                    .toArray(),
                userCollection
                    .find({ total_ton_contribution: { $exists: true, $gt: 0 } })
                    .sort({ total_ton_contribution: -1 })
                    .project({ name: 1, total_ton_contribution: 1 })
                    .limit(100)
                    .toArray(),
                metadataCollection.findOne({ meta_id: 'public_sale' }, { projection: { _id: 0, meta_id: 0 } }),
                userCollection.findOne({ tele_id: tele_user.tele_id }, { projection: { _id: 0, total_ton_contribution: 1 } }),
                userCollection.countDocuments({ total_ton_contribution: { $exists: true, $gt: 0 } })
            ]);

            res.status(200).json({
                historys,
                meta: { ...meta, total_ton_contribution: (meta?.total_ton_contribution || 0) + 2540 },
                user,
                total_participant,
                contributors: contributors.map(i => ({ ...i, name: (i.name?.length || 0) >= 5 ? i.name.slice((i.name?.length || 0) - 6, (i.name?.length || 0)) : i.name })),
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Internal server error" });
        };
    });
};