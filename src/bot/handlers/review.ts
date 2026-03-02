import type { Bot } from 'grammy';
import { logger } from '../../utils/logger.js';
import {
  updatePageStatus,
  updatePageProperty,
  archiveNotionPage,
} from '../../notion/index.js';

export function registerReviewHandler(bot: Bot): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Handle review callbacks: review:<action>:<pageId>
    if (data.startsWith('review:')) {
      const parts = data.split(':');
      if (parts.length !== 3) return;

      const [, action, pageId] = parts;
      await ctx.answerCallbackQuery();

      try {
        let confirmText: string;

        switch (action) {
          case 'keep':
            confirmText = '✓ Behalten';
            break;
          case 'archive':
            await updatePageStatus(pageId, 'archived');
            confirmText = '🗄️ Archiviert';
            break;
          case 'done':
            await updatePageStatus(pageId, 'done');
            confirmText = '✅ Erledigt';
            break;
          case 'blocked':
            await updatePageStatus(pageId, 'blocked');
            confirmText = '🚧 Blockiert';
            break;
          case 'cancel':
            await updatePageStatus(pageId, 'cancelled');
            confirmText = '❌ Abgebrochen';
            break;
          default:
            return;
        }

        await ctx.editMessageText(
          `${ctx.callbackQuery.message?.text ?? ''}\n\n→ ${confirmText}`,
          { parse_mode: 'HTML' },
        );

        logger.info({ event: 'review_action', action, pageId });
      } catch (err) {
        logger.error({ event: 'review_action_failed', action, pageId, error: String(err) });
        await ctx.reply('Fehler beim Aktualisieren. Bitte versuche es nochmal.');
      }
      return;
    }

    // Handle curation callbacks: curate:<potential>:<pageId>
    if (data.startsWith('curate:')) {
      const parts = data.split(':');
      if (parts.length !== 3) return;

      const [, value, pageId] = parts;
      await ctx.answerCallbackQuery();

      try {
        let confirmText: string;

        if (value === 'archive') {
          await archiveNotionPage(pageId);
          confirmText = '🗄️ Archiviert';
        } else {
          await updatePageProperty(pageId, 'Potential', value);
          confirmText = `Bewertet: ${value}`;
        }

        await ctx.editMessageText(
          `${ctx.callbackQuery.message?.text ?? ''}\n\n→ ${confirmText}`,
          { parse_mode: 'HTML' },
        );

        logger.info({ event: 'curate_action', value, pageId });
      } catch (err) {
        logger.error({ event: 'curate_action_failed', value, pageId, error: String(err) });
        await ctx.reply('Fehler beim Aktualisieren. Bitte versuche es nochmal.');
      }
      return;
    }
  });
}
