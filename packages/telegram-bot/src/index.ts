#!/usr/bin/env node
/**
 * @rai/telegram-bot — RAI consumer beachhead via Telegram.
 *
 * Public bot. User forwards a suspicious message → bot replies with verdict.
 * Per-chat isolation. P0 only (free tier, local regex, no API key needed).
 *
 * Env:
 *   RAI_TELEGRAM_BOT_TOKEN  required, from @BotFather
 *
 * Run:
 *   node dist/index.js
 *
 * Deploy:
 *   systemd user service on VPS (separate from NanoClaw)
 */

import { Bot } from 'grammy';
import { scanForChat, WELCOME_MESSAGE, HELP_MESSAGE } from './handler.js';

const token = process.env.RAI_TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('[rai-bot] RAI_TELEGRAM_BOT_TOKEN env var is required');
  process.exit(1);
}

const bot = new Bot(token);

bot.command('start', (ctx) => {
  return ctx.reply(WELCOME_MESSAGE, { parse_mode: 'Markdown' });
});

bot.command('help', (ctx) => {
  return ctx.reply(HELP_MESSAGE, { parse_mode: 'Markdown' });
});

bot.command('privacy', (ctx) => {
  return ctx.reply(
    'Privacy policy: https://raw.githubusercontent.com/pektimole/rai/main/packages/extension/PRIVACY_POLICY.md',
  );
});

// Handle any text message: scan + reply.
// Telegram automatically delivers forwarded messages with .text populated, so
// the same handler covers both "user typed" and "user forwarded" cases.
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (!text || text.trim().length === 0) return;

  // Skip messages that look like commands we already handle
  if (text.startsWith('/')) return;

  const chatId = ctx.chat.id;

  try {
    const result = await scanForChat(text, chatId);
    await ctx.reply(result.reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[rai-bot] scan error', err);
    await ctx.reply(
      '⚠️ Scanner unavailable. Try again in a moment.',
      { parse_mode: 'Markdown' },
    );
  }
});

// Catch-all for non-text messages (photos, stickers, etc) — politely decline
bot.on('message', (ctx) => {
  return ctx.reply(
    'I only scan text messages. Forward or paste suspicious text to scan it.',
  );
});

bot.catch((err) => {
  console.error('[rai-bot] uncaught error', err);
});

console.log('[rai-bot] starting...');
bot.start({
  onStart: (info) => {
    console.log(`[rai-bot] ready as @${info.username}`);
  },
});

// Graceful shutdown
const shutdown = async (signal: string): Promise<void> => {
  console.log(`[rai-bot] received ${signal}, shutting down`);
  await bot.stop();
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
