import Database from "./libs/database";

type Config = {
    config_type: string;
    [key: string]: any;
};

class watchCollection {
    public config: Config[] = [];
    private collection: string;
    private config_map: Map<string, any> = new Map();

    constructor(collection: string) {
        this.collection = collection;

        this.watch();
    };

    async watch() {
        const dbInstance = Database.getInstance();
        const db = await dbInstance.getDb();
        const collection = db.collection(this.collection);
        const changeStream = collection.watch();

        this.config = await collection.find().project({ _id: 0 }).toArray() as Config[];

        this.config_map = new Map(this.config.map(i => [i.config_type, i]));

        changeStream.on('change', async () => {
            this.config = await collection.find().project({ _id: 0 }).toArray() as Config[];

            this.config_map = new Map(this.config.map(i => [i.config_type, i]));
        });

        changeStream.on('end', this.watch);
    };

    async GET(config_type: string) {
        if (this.config.length === 0) {
            const dbInstance = Database.getInstance();
            const db = await dbInstance.getDb();
            const collection = db.collection(this.collection);

            this.config = await collection.find().project({ _id: 0 }).toArray() as Config[];

            this.config_map = new Map(this.config.map(i => [i.config_type, i]));
        };

        return this.config_map.get(config_type);
    };
}

export const CONFIG = new watchCollection('config');