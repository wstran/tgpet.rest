import IORedis, { Redis } from 'ioredis';

export class RedisWrapper {
    private redisClient: Redis;
    private localMap: Map<string, any> = new Map();
    private useRedis: boolean = true;

    constructor(redisUrl: string) {
        this.redisClient = new IORedis(redisUrl, { retryStrategy: (times) => Math.min(times * 50, 2000) });

        this.redisClient.on('connect', () => {
            this.useRedis = true;
        });

        this.redisClient.on('error', () => {
            this.useRedis = false;
        });

        this.redisClient.on('end', () => {
            this.useRedis = false;
        });
    };

    async get(key: string): Promise<string | null> {
        if (this.useRedis) {
            const type = await this.redisClient.type(key);

            if (type !== 'string') {
                console.error(`Attempted to retrieve a string from key ${key}, found type ${type}`);
                return null;
            };

            return await this.redisClient.get(key);
        } else {
            return this.localMap.get(key) ?? null;
        };
    };

    async set(key: string, value: string, ttl: number): Promise<void> {
        if (this.useRedis) {
            await this.redisClient.set(key, value, 'EX', ttl);
        } else {
            this.localMap.set(key, value);
            setTimeout(() => this.localMap.delete(key), ttl * 1000);
        };
    };

    async add(key: string, value: string, ttl: number): Promise<boolean> {
        if (this.useRedis) {
            const acquired = await this.redisClient.setnx(`${key}:${value}`, 1);

            if (acquired) {
                await this.redisClient.expire(`${key}:${value}`, ttl);
                return true;
            };

            return false;
        } else {
            const mapKey = `${key}:${value}`;

            if (!this.localMap.has(mapKey)) {
                this.localMap.set(mapKey, 1);
                setTimeout(() => this.localMap.delete(mapKey), ttl * 1000);
                return true;
            };

            return false;
        };
    };

    async has(key: string, value: string): Promise<boolean> {
        if (this.useRedis) {
            return (await this.redisClient.exists(`${key}:${value}`)) === 1;
        } else {
            return this.localMap.has(`${key}:${value}`);
        };
    };

    async delete(key: string, value: string): Promise<void> {
        if (this.useRedis) {
            await this.redisClient.del(`${key}:${value}`);
        } else {
            this.localMap.delete(`${key}:${value}`);
        };
    };
};