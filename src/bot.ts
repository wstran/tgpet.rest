/* import { Markup, Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import Database from './libs/database';
import path from 'path';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN as string);

bot.start((ctx) => {
  const welcomeMessage = `🎖️ Start farming, invite your frens, earn more coins, boost your ranking, and get more airdrop rewards!

  🎁 Play-to-earn airdrop right now! Farm $xLOTP or become my next exit liquidity on $TON ⛏`;

  const operationMenu = Markup.inlineKeyboard([
    [Markup.button.url('Join Community', 'https://t.me/lottefi_app')],
    [Markup.button.url('Play Game 🎮', 'https://t.me/lottefiapp_bot/app')],
  ]);

  ctx.reply(welcomeMessage, {
    parse_mode: 'HTML',
    reply_markup: operationMenu.reply_markup,
  });
});

bot.command('play', (ctx) => {
  const playMessage = `
    <b>🎁 Play-to-earn airdrop right now!</b>
  `;

  const playButton = Markup.inlineKeyboard([
    [Markup.button.url('Play Game 🎮', 'https://t.me/lottefiapp_bot/app')],
  ]);

  ctx.reply(playMessage, {
    parse_mode: 'HTML',
    reply_markup: playButton.reply_markup,
  });
});

bot.command('invite', async (ctx) => {
  if (ctx.chat?.type === 'private') {
    const userId = ctx.from?.id.toString();

    const dbInstance = Database.getInstance();
    const db = await dbInstance.getDb();
    const userCollection = db.collection('users');

    const user = await userCollection.findOne({ tele_id: userId }, { projection: { _id: 0, invite_code: 1 } });

    let inviteMessage: string;

    if (user?.invite_code) {
      inviteMessage = `<b>Invite the farmers around and get bonuses for each invited frens! 🎁</b>\n\nYour referral link: <code>https://t.me/lottefiapp_bot/app?startapp=${user?.invite_code}</code>`;
    } else {
      inviteMessage = `<b>If you haven't joined yet, please launch to join: </b>https://t.me/lottefiapp_bot/app`;
    };

    ctx.reply(inviteMessage, { parse_mode: 'HTML' });
  }
});

bot.command('checkairdrop', async (ctx) => {
  if (ctx.chat?.type === 'private') {
    const userId = ctx.from?.id.toString();

    const dbInstance = Database.getInstance();
    const db = await dbInstance.getDb();
    const airdropCollection = db.collection('users_airdrop');

    const userReward = await airdropCollection.findOne({ tele_id: userId });

    if (userReward) {
      const checkInStatus = userReward.CheckIn ? 'Yes' : 'No';

      const rewardMessage = `
<b>Your Rewards:</b>
- Ticket Count: ${userReward.Ticket_Count}
- Roll Count: ${userReward.Roll_Count}
- Machine Level: ${userReward.Machine_Level}
- Check-In Status: ${checkInStatus}
- Lottery Reward: ${userReward.Lottery_Reward} $LOTP
- Dice Reward: ${userReward.Dice_Reward} $LOTP
- Machine Reward: ${userReward.Machine_Reward} $LOTP
- Check-In Reward: ${userReward.CheckIn_Reward} $LOTP
- <b>Total Reward: ${userReward.Total_Reward} $LOTP</b>
`;

      const imagePath = path.join(__dirname, 'image', 'airdrop.jpg');

      const claimButton = Markup.inlineKeyboard([
        [Markup.button.url('Claim Your AirDrop', 'https://t.me/lottefiapp_bot/app')],
      ]);

      ctx.replyWithPhoto(
        { source: imagePath },
        {
          caption: rewardMessage,
          parse_mode: 'HTML',
          reply_markup: claimButton.reply_markup,
        }
      );
    } else {
      ctx.reply('You do not have any rewards yet.');
    }
  }
});

bot.help((ctx) => {
  const helpMessage = `Here's how you can get started with LotteFi App:
- To begin mining <code>$xLOTP</code>, just follow the three steps mentioned in the start message.
- If you encounter any issues or have questions, feel free to ask here.

For more detailed help or feedback, visit our channel: https://t.me/lottefi_app`;

  ctx.reply(helpMessage, { parse_mode: 'HTML' });
});

bot.on('text', async (ctx) => {
  if (ctx.chat?.type === 'private') {
    // Add your text handling logic here if needed
  }
});

export default bot;
 */