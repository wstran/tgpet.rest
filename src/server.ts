import express from 'express';
import session from 'express-session';
import cors from 'cors';
import Apis from './apis';
import Database from './libs/database';
import RateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';
import './config';

if (
  !process.env.PORT_BE ||
  !process.env.REDIS_URL ||
  !process.env.WEBHOOK_URL ||
  !process.env.CLIENT_URL ||
  !process.env.BOT_TOKEN ||
  !process.env.SESSION_SECRET
) {
  throw Error('No environment variable found!');
}

const app = express();
const port = process.env.PORT_BE || 8000;

const redisClient = new Redis(process.env.REDIS_URL, { retryStrategy: (times) => Math.min(times * 50, 2000) });

const limiter = RateLimit({
  store: new RedisStore({
    // @ts-ignore
    sendCommand: (...args: string[]) => redisClient.call(...args),
  }),
  windowMs: 1000,
  max: 10,
  statusCode: 429,
  message: 'Too many requests.',
  standardHeaders: false,
  legacyHeaders: false,
});

app.use(limiter);

app.use(express.json());

app.use(
  cors({
    origin: [process.env.CLIENT_URL, 'http://localhost:3000'],
    credentials: true,
  })
);

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' },
  })
);

app.use((_, res, next) => {
  res.header('Access-Control-Allow-Headers', 'Content-Type, --webapp-init');
  next();
});

app.use('/api', Apis);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// create index
(async () => {
  const dbInstance = Database.getInstance();
  const db = await dbInstance.getDb();
  const configCollection = db.collection('config');
  const userCollection = db.collection('users');
  const petCollection = db.collection('pets');
  const logCollection = db.collection('logs');

  // indexes of config
  await configCollection.createIndex({ config_type: 1 });
  await configCollection.createIndex({ quest_id: 1 }, { unique: true, sparse: true });

  // indexes of users
  await userCollection.createIndex({ tele_id: 1 }, { unique: true });
  await userCollection.createIndex({ invite_code: 1 }, { unique: true });
  await userCollection.createIndex({ referral_code: 1 }, { sparse: true });
  await userCollection.createIndex({ username: 1 }, { sparse: true });
  await userCollection.createIndex({ 'user_refs.tele_id': 1 }, { unique: true, sparse: true });
  await userCollection.createIndex({ 'user_refs.verified': 1 }, { sparse: true });
  await userCollection.createIndex({ 'wallet.address': 1 }, { unique: true, sparse: true });

  // indexes of pets
  await petCollection.createIndex({ tele_id: 1, type: 1 });

  // indexes of logs
  await logCollection.createIndex({ log_type: 1, tele_id: 1 });
})();