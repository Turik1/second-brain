import type { Bot } from 'grammy';
import { captureThought } from '../../brain/index.js';
import { logger } from '../../utils/logger.js';
import {
  checkRateLimit,
  incrementPending,
  decrementPending,
  markMessageProcessed,
} from '../../utils/state.js';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function registerMessageHandler(bot: Bot): void {
  // Handle non-text messages
  bot.on('message', async (ctx, next) => {
    if (!ctx.message.text) {
      await ctx.reply('Text only for now, please.');
      return;
    }
    await next();
  });

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    const messageText = ctx.message.text;
    const telegramMessageId = ctx.message.message_id;
    const chatId = ctx.chat.id;

    // Skip commands — let command handlers deal with them
    if (messageText.startsWith('/')) return;

    if (!checkRateLimit(String(chatId))) {
      await ctx.reply('Zu viele Nachrichten. Bitte kurz warten.');
      return;
    }

    logger.info({ event: 'message_received', chatId, messageId: telegramMessageId, text_length: messageText.length });

    incrementPending();
    try {
      const thought = await captureThought({
        content: messageText,
        source: 'telegram',
        source_id: String(telegramMessageId),
        chat_id: chatId,
      });

      if (thought) {
        const receipt = [
          `<b>${escapeHtml(thought.title ?? messageText.slice(0, 50))}</b>`,
          thought.thought_type ? `Typ: ${thought.thought_type}` : '',
          thought.due_date ? `Fällig: ${new Date(thought.due_date).toISOString().slice(0, 10)}` : '',
          thought.priority ? `Priorität: ${thought.priority}` : '',
          thought.topics?.length ? `Themen: ${thought.topics.join(', ')}` : '',
          thought.people?.length ? `Personen: ${thought.people.join(', ')}` : '',
        ].filter(Boolean).join('\n');

        await ctx.reply(receipt, {
          parse_mode: 'HTML',
          reply_parameters: { message_id: telegramMessageId },
        });
      } else {
        await ctx.reply('Fehler beim Speichern. Bitte erneut versuchen.');
      }

      markMessageProcessed();
    } finally {
      decrementPending();
    }
  });
}
