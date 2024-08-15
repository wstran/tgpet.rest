import Database from './libs/database';

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

        changeStream.on('change', async (change) => {
            if (change.operationType === 'update') {

                if (change.updateDescription?.updatedFields) {
                    this.config = this.config.map(i => ({ ...i, ...change.updateDescription.updatedFields }));

                    this.config_map = new Map(this.config.map(i => [i.config_type, { ...i, ...change.updateDescription.updatedFields }]));
                };
            } else {
                this.config = await collection.find().project({ _id: 0 }).toArray() as Config[];

                this.config_map = new Map(this.config.map(i => [i.config_type, i]));
            };
        });

        changeStream.on('end', () => this.watch);
    };

    GET(config_type: string) {
        return this.config_map.get(config_type);
    };
}

export const CONFIG = new watchCollection('config');