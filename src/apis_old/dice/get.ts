/* import { Router } from "express";
import Middleware, { RequestWithUser } from "../../middlewares/webapp-telegram";
import Database from "../../libs/database";

const types = [
    "get_dice",
];

export default function (router: Router) {
    router.get("/dice/get", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        const { type } = req.query;

        if (typeof type !== "string" || !types.includes(type)) {
            res.status(401).json({ message: "Bad Request" });
            return;
        };

        try {
            const dbInstance = Database.getInstance();
            const db = await dbInstance.getDb();
            const userCollection = db.collection("users");
            const configCollection = db.collection("config");

            
            
            throw Error("Query is not acknowledged");
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Internal server error" });
        };
    });
}; */