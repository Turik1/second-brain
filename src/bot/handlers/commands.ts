import { Bot } from 'grammy';
import { logger } from '../../utils/logger.js';
import { generateDailyDigest, generateWeeklyDigest, generateOverview } from '../../digest/index.js';

export function registerCommandHandlers(bot: Bot, sendToUser: (text: string) => Promise<void>): void {
  bot.command('start', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /start');
    await ctx.reply(
      '<b>Second Brain</b> is ready!\n\n' +
        'Schick mir einfach eine Nachricht — ich erfasse und speichere sie automatisch.\n\n' +
        'Use /help to see all commands.',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('help', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /help');
    await ctx.reply(
      '<b>Commands:</b>\n' +
        '/start — Introduction\n' +
        '/help — This message\n' +
        '/digest — Daily digest (last 24h)\n' +
        '/weekly — Weekly digest (last 7 days)\n' +
        '/overview — Current state overview\n\n' +
        'Schick mir einfach Text, um Gedanken zu erfassen.',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('digest', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /digest');
    await ctx.reply('Generating daily digest...');
    try {
      await generateDailyDigest(sendToUser);
    } catch (err) {
      logger.error({ error: err }, 'Manual daily digest failed');
      await ctx.reply('Failed to generate digest. Check logs for details.');
    }
  });

  bot.command('weekly', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /weekly');
    await ctx.reply('Generating weekly digest...');
    try {
      await generateWeeklyDigest(sendToUser);
    } catch (err) {
      logger.error({ error: err }, 'Manual weekly digest failed');
      await ctx.reply('Failed to generate weekly digest. Check logs for details.');
    }
  });

  bot.command('overview', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /overview');
    await ctx.reply('Generating overview, this may take a moment...');
    try {
      await generateOverview(sendToUser);
    } catch (err) {
      logger.error({ error: err }, 'Overview generation failed');
      await ctx.reply('Failed to generate overview. Check logs for details.');
    }
  });
}
