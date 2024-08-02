import { Router } from "express";
import Middleware, { RequestWithUser } from "../../middlewares/webapp-telegram";
import Database from "../../libs/database";

const types = [
    "get_ticket",
    "get_all_historys",
    "get_weekly_historys",
    "get_daily_historys",
    "get_current_pools",
    "get_pool",
];

function getCurrentDate() {
    const date = new Date();
    const diff = date.getUTCDate();
    date.setUTCHours(0, 0, 0, 0);
    return new Date(date.setUTCDate(diff));
};

function getMondayOfCurrentWeek() {
    const date = new Date();
    const day = date.getUTCDay();
    const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
    date.setUTCHours(0, 0, 0, 0);
    return new Date(date.setUTCDate(diff));
};

export default function (router: Router) {
    router.get("/lottery/get", Middleware, async (req, res) => {
        const tele_user = (req as RequestWithUser).tele_user;

        const { type } = req.query;

        if (typeof type !== "string" || !types.includes(type)) {
            res.status(401).json({ message: "Bad Request" });
            return;
        }

        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const userCollection = db.collection("users");
        const lotteryPoolCollection = db.collection("lottery_pools");

        try {
            if (type === "get_ticket") {
                const address = (
                    await userCollection.findOne(
                        { tele_id: tele_user.tele_id },
                        { projection: { _id: 0, "wallet.address": 1 } }
                    )
                )?.wallet.address;

                const result = await lotteryPoolCollection
                    .aggregate([
                        {
                            $match: {
                                status: "processing",
                                "user_tickets.address": address,
                            },
                        },
                        {
                            $project: {
                                user_tickets: {
                                    $filter: {
                                        input: "$user_tickets",
                                        as: "ticket",
                                        cond: { $eq: ["$$ticket.address", address] },
                                    },
                                },
                                _id: 0,
                            },
                        },
                        {
                            $unwind: "$user_tickets",
                        },
                        {
                            $project: {
                                total_tickets: "$user_tickets.total_tickets",
                            },
                        },
                    ])
                    .toArray();

                const total_tickets = result.reduce(
                    (prev, current) => prev + (current.total_tickets || 0),
                    0
                );

                res.status(200).json({ total_tickets });

                return;
            } else if (type === "get_all_historys") {
                const reslut = await lotteryPoolCollection
                    .aggregate([
                        { $match: { status: "processed" } },
                        { $sort: { created_at: -1 } },
                        {
                            $project: {
                                pool_type: 1,
                                pool_time: 1,
                                total_tickets: { $size: { $ifNull: ["$pool_tickets", []] } },
                                total_winners: { $size: { $ifNull: ["$user_winners", []] } },
                            },
                        },
                    ])
                    .toArray();

                res.status(200).json(reslut);

                return;
            } else if (type === "get_weekly_historys") {
                const reslut = await lotteryPoolCollection
                    .aggregate([
                        { $match: { status: "processed", pool_type: "weekly" } },
                        { $sort: { created_at: -1 } },
                        {
                            $project: {
                                pool_type: 1,
                                pool_time: 1,
                                total_tickets: { $size: { $ifNull: ["$pool_tickets", []] } },
                                total_winners: { $size: { $ifNull: ["$user_winners", []] } },
                            },
                        },
                    ])
                    .toArray();

                res.status(200).json(reslut);

                return;
            } else if (type === "get_daily_historys") {
                const reslut = await lotteryPoolCollection
                    .aggregate([
                        { $match: { status: "processed", pool_type: "daily" } },
                        { $sort: { created_at: -1 } },
                        {
                            $project: {
                                pool_type: 1,
                                pool_time: 1,
                                total_tickets: { $size: { $ifNull: ["$pool_tickets", []] } },
                                total_winners: { $size: { $ifNull: ["$user_winners", []] } },
                            },
                        },
                    ])
                    .toArray();

                res.status(200).json(reslut);

                return;
            } else if (type === "get_current_pools") {
                const [weekly_pool, daily_pool] = await Promise.all([
                    lotteryPoolCollection
                        .aggregate([
                            {
                                $match: {
                                    pool_type: "weekly",
                                    pool_time: getMondayOfCurrentWeek(),
                                    status: "processing",
                                },
                            },
                            {
                                $project: {
                                    total_tickets: { $size: { $ifNull: ["$pool_tickets", []] } },
                                    total_users: { $size: { $ifNull: ["$user_tickets", []] } },
                                    user_tickets: 1,
                                },
                            },
                        ])
                        .next(),
                    lotteryPoolCollection
                        .aggregate([
                            {
                                $match: { pool_type: "daily", pool_time: getCurrentDate(), status: "processing" },
                            },
                            {
                                $project: {
                                    total_tickets: { $size: { $ifNull: ["$pool_tickets", []] } },
                                    total_users: { $size: { $ifNull: ["$user_tickets", []] } },
                                    user_tickets: 1,
                                },
                            },
                        ])
                        .next(),
                ]);

                res.status(200).json({ weekly_pool, daily_pool });

                return;
            } else if (type === "get_pool") {
                const { pool_type, pool_time } = req.query;

                if (typeof pool_time !== 'string' || typeof pool_time !== 'string') return;

                const result = await lotteryPoolCollection
                    .aggregate([
                        { $match: { pool_type, pool_time: new Date(pool_time), status: "processed" } },
                        {
                            $project: {
                                _id: 0,
                                total_tickets: { $size: { $ifNull: ["$pool_tickets", []] } },
                                total_users: { $size: { $ifNull: ["$user_tickets", []] } },
                                results: 1,
                                user_winners: 1,
                            },
                        },
                    ])
                    .next();

                res.status(200).json(result);

                return;
            };

            throw Error("Query is not acknowledged");
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Internal server error" });
        };
    });
};