import { Bot } from 'grammy';
import { logger } from '../../utils/logger.js';
import { verifyDatabases } from '../../notion/databases.js';

export function registerCommandHandlers(bot: Bot): void {
  bot.command('start', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /start');
    await ctx.reply(
      '<b>Second Brain</b> is ready!\n\n' +
        "Just send me any thought, task, note, or idea — I'll classify and file it automatically.\n\n" +
        "If I'm not sure where something belongs, I'll ask you.\n\n" +
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
        '/status — Check Notion connectivity\n\n' +
        '<b>To fix a mis-filed entry:</b>\n' +
        'Reply to the receipt message with:\n' +
        '<code>fix: people</code>\n' +
        '<code>fix: projects</code>\n' +
        '<code>fix: ideas</code>\n' +
        '<code>fix: admin</code>\n\n' +
        '<b>Categories:</b> people, projects, ideas, admin',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('status', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /status');
    await ctx.reply('Checking Notion connectivity...');
    try {
      const results = await verifyDatabases();
      const lines = results.map((r) => `${r.ok ? '✓' : '✗'} ${r.db}${r.error ? `: ${r.error}` : ''}`);
      const allOk = results.every((r) => r.ok);
      await ctx.reply(
        `<b>Notion Status:</b> ${allOk ? 'All connected' : 'Some issues found'}\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      logger.error({ error: err }, 'Status check failed');
      await ctx.reply('Failed to check Notion connectivity. Check logs for details.');
    }
  });
}
