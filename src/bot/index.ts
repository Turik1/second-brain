import { Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { registerCommandHandlers } from './handlers/commands.js';
import { registerMessageHandler } from './handlers/message.js';

export function createBot(sendToUser: (text: string) => Promise<void>): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Middleware: chat ID allowlist - silently ignore all other chats
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== config.ALLOWED_CHAT_ID) {
      logger.warn({ chatId }, 'Ignoring message from non-allowlisted chat');
      return;
    }
    await next();
  });

  // Register handlers: commands first, then general message
  registerCommandHandlers(bot, sendToUser);
  registerMessageHandler(bot);

  // Global error handler
  bot.catch((err) => {
    logger.error({ error: err.error, update: err.ctx?.update }, 'Unhandled bot error');
  });

  logger.info('Bot instance created with middleware and handlers');
  return bot;
}
