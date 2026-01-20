// @ts-nocheck
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { fetch as undiciFetch } from 'undici';

const token = process.env.BOT_TOKEN;
if (!token) {
  // eslint-disable-next-line no-console
  console.error('BOT_TOKEN not set in .env');
  process.exit(1);
}
const miniAppUrl = String(process.env.MINIAPP_URL || 'https://app.miraplay.ru');
const ozonUrl = String(process.env.OZON_URL || 'https://ozon.ru/seller');
const wbUrl = String(process.env.WB_URL || 'https://wildberries.ru/seller');
const termsUrl = String(process.env.TERMS_URL || 'https://miraplay.ru/terms');

const bot = new Telegraf(token);

bot.start(async (ctx) => {
  // Принятие дружбы: t.me/<bot>?start=friend_<code>
  const payload = (ctx as any).startPayload as string | undefined;
  const match = /^friend_([A-Za-z0-9_-]{8,})$/.exec(payload || '');
  if (match) {
    try {
      const code = match[1];
      const tgId = String(ctx.from?.id || '');
      const tgUsername = String(ctx.from?.username || '');
      await undiciFetch('http://localhost:4000/api/friends/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, tgId, tgUsername }),
      }).then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as any;
        if (r.ok && (data?.ok || data?.status === 'ok')) {
          await ctx.reply('Готово! Вы добавлены друг другу в друзья. Откройте приложение, чтобы играть вместе.', {
            reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: String(miniAppUrl) } }]] },
          } as any);
        } else {
          await ctx.reply('Не удалось принять приглашение. Ссылка недействительна или истекла. Попросите друга создать новую ссылку.');
        }
      }).catch(async () => {
        await ctx.reply('Не удалось связаться с сервером для принятия приглашения. Попробуйте позже.');
      });
    } catch {
      await ctx.reply('Ошибка при обработке приглашения. Попробуйте позже.');
    }
  }

  // Присоединение в лобби: t.me/<bot>?start=join_<lobbyId>
  const joinMatch = /^join_([A-Za-z0-9-]{10,})$/i.exec(payload || '');
  if (joinMatch) {
    try {
      const lobbyId = joinMatch[1];
      const tgId = String(ctx.from?.id || '');
      const tgUsername = String(ctx.from?.username || '');
      await undiciFetch(`http://localhost:4000/api/lobbies/${encodeURIComponent(lobbyId)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tgId, tgUsername }),
      }).then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as any;
        if (r.ok && (data?.id || data?.ok)) {
          const url = String(miniAppUrl) + `?lobby=${encodeURIComponent(lobbyId)}`;
          await ctx.reply('Вы присоединились к лобби. Откройте приложение, чтобы начать игру.', {
            reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url } }]] },
          } as any);
        } else {
          const err = (data && (data.error as string)) || 'Ошибка';
          if (err === 'invite_expired') await ctx.reply('Приглашение истекло. Попросите хоста отправить новое.');
          else if (err === 'lobby_full') await ctx.reply('Лобби уже заполнено.');
          else if (err === 'lobby_not_open') await ctx.reply('Лобби закрыто.');
          else await ctx.reply('Не удалось присоединиться к лобби.');
        }
      }).catch(async () => {
        await ctx.reply('Не удалось связаться с сервером. Попробуйте позже.');
      });
    } catch {
      await ctx.reply('Ошибка при попытке присоединиться к лобби.');
    }
  }

  const caption = [
    'MIRA GPT Games - лучший виртуальный ведущий для проведения игр с друзьями!',
    'Попробуй технологии искусственного интеллекта в действии!',
  ].join('\n');

  const keyboard = { inline_keyboard: [
    [{ text: 'Запустить приложение', web_app: { url: String(miniAppUrl) } }],
    [{ text: 'Наши игры на OZON', url: String(ozonUrl) }],
    [{ text: 'А также на Wildberries', url: String(wbUrl) }],
    [{ text: 'Пользовательское соглашение', url: String(termsUrl) }],
  ] } as const;

  await ctx.replyWithPhoto({ url: 'https://i.ibb.co/2ZyqCwJ/mira-cover.jpg' }, { caption, reply_markup: keyboard as any } as any);
});



// Start in long-polling (для локальной разработки)
bot.launch().then(() => {
  // eslint-disable-next-line no-console
  console.log('Bot started');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


