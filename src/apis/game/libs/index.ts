import { roundDown } from "../../../libs/custom";
import { AnyBulkWriteOperation, Document, ObjectId } from "mongodb";
import { CONFIG } from '../../../config';

export interface Pet {
    _id: ObjectId,
    type: string,
    level: number,
    tele_id: string,
    farm_at?: Date,
    mana: Date,
    max_mana: number,
    balance?: number,
    accumulate_total_cost: number
}

export const caculateFarmBoost = (
    current_timestamp: number,
    pets: Pet[],
    boosts: { percent: number; start_at: string; end_at: string }[]
): number => {
    const config = CONFIG.GET('farm_data');

    let boost_points = 0;

    for (let i = 0; i < pets.length; ++i) {
        const { farm_at, mana, accumulate_total_cost } = pets[i];

        const farm_timestamp = farm_at?.getTime();
        const mana_timestamp = mana.getTime();

        if (!!farm_timestamp) {
            const farm_speed = (accumulate_total_cost - config.x_average_TGP) / config.y_day_to_break_even;

            for (let i = 0; i < boosts.length; ++i) {
                const start_at = Date.parse(boosts[i].start_at);
                const end_at = Date.parse(boosts[i].end_at);
                
                const start_timestamp = start_at > farm_timestamp ? start_at : farm_timestamp;

                const end_timestamp = end_at > current_timestamp ? (current_timestamp > mana_timestamp ? current_timestamp : mana_timestamp) : end_at;
                
                boost_points += ((end_timestamp - start_timestamp) / (24 * 60 * 60 * 1000) * farm_speed) / 100 * boosts[i].percent;
            };    
        };
    };

    return boost_points;
}

export const caculateFarmAmount = (pets: Pet[], now_date: Date): [number, AnyBulkWriteOperation<Document>[]] => {
    const config = CONFIG.GET('farm_data');

    let farm_points = 0;

    const bulkOps: AnyBulkWriteOperation<Document>[] = [];

    const current_timestamp = now_date.getTime();

    for (let i = 0; i < pets.length; ++i) {
        const { _id, farm_at, mana, balance, accumulate_total_cost } = pets[i];

        const farm_speed = (accumulate_total_cost - config.x_average_TGP) / config.y_day_to_break_even;

        const farm_timestamp = farm_at?.getTime();
        const mana_timestamp = mana.getTime();
        const farm_balance = (balance || 0);

        if (current_timestamp >= mana_timestamp) {
            const points = (farm_timestamp
                ? ((mana_timestamp - farm_timestamp) / (24 * 60 * 60 * 1000)) * farm_speed
                : 0) + farm_balance;

            farm_points += points;

            bulkOps.push({
                updateOne: {
                    filter: { _id },
                    update: {
                        $set: { balance: 0 },
                        $unset: { farm_at: 1 },
                        $inc: { 'totals.game_claim_tgp': points }
                    }
                }
            });
        } else {
            const points = (farm_timestamp
                ? ((current_timestamp - farm_timestamp) / (24 * 60 * 60 * 1000)) * farm_speed
                : 0) + farm_balance;

            farm_points += points;

            bulkOps.push({
                updateOne: {
                    filter: { _id },
                    update: {
                        $set: { balance: 0, farm_at: now_date },
                        $inc: { 'totals.game_claim_tgp': points }
                    }
                }
            });
        };
    };

    return [Number(roundDown(farm_points, 2)), bulkOps];
}