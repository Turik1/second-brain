import { Bot } from 'grammy';
import { logger } from '../../utils/logger.js';
import { findThoughtBySourceId, updateThoughtStatus, listOpenTasks } from '../../db/index.js';
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

  bot.command('done', async (ctx) => {
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo) {
      await ctx.reply('Antworte auf eine Nachricht mit /done, um sie als erledigt zu markieren.');
      return;
    }

    // The receipt is a reply to the original — get the original message ID
    // grammY strips reply_to_message from ReplyMessage type, but it exists at runtime
    const nested = replyTo as { reply_to_message?: { message_id: number } };
    const originalMessageId = nested.reply_to_message?.message_id ?? replyTo.message_id;
    const chatId = ctx.chat.id;

    const thought = await findThoughtBySourceId(String(originalMessageId), chatId);
    if (!thought) {
      await ctx.reply('Gedanke nicht gefunden.');
      return;
    }

    if (thought.status === 'done') {
      await ctx.reply('Bereits erledigt.');
      return;
    }

    const updated = await updateThoughtStatus(thought.id, 'done');
    if (updated) {
      await ctx.reply(`✓ Erledigt: ${updated.title ?? updated.content.slice(0, 50)}`);
      logger.info({ thoughtId: updated.id, title: updated.title }, 'Thought marked done');
    } else {
      await ctx.reply('Fehler beim Aktualisieren.');
    }
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
