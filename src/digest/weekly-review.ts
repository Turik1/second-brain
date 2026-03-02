import { InlineKeyboard } from 'grammy';
import { logger } from '../utils/logger.js';
import {
  queryStaleProjects,
  queryOldPendingAdmin,
  queryByProperty,
  summarizePage,
} from '../notion/index.js';
import { config } from '../config.js';

interface ReviewMessage {
  text: string;
  keyboard?: InlineKeyboard;
}

export async function generateWeeklyReview(
  sendFn: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
): Promise<void> {
  const startMs = Date.now();

  logger.info({ event: 'weekly_review_start' });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [staleProjects, oldAdmin, uncuratedIdeas] = await Promise.all([
    queryStaleProjects(sevenDaysAgo, 5),
    queryOldPendingAdmin(fourteenDaysAgo, 5),
    queryByProperty(config.NOTION_DB_IDEAS, 'Potential', 'unknown', 5),
  ]);

  const messages: ReviewMessage[] = [];

  if (staleProjects.length > 0 || oldAdmin.length > 0 || uncuratedIdeas.length > 0) {
    messages.push({ text: '<b>📋 Weekly Review</b>\n\nZeit für eine kurze Bestandsaufnahme:' });
  }

  // Stale projects
  for (const page of staleProjects) {
    const title = summarizePage(page).slice(0, 80);
    const daysSince = Math.floor((Date.now() - new Date(page.last_edited_time).getTime()) / 86400000);

    const keyboard = new InlineKeyboard()
      .text('Noch relevant', `review:keep:${page.id}`)
      .text('Archivieren', `review:archive:${page.id}`)
      .row()
      .text('Blockiert', `review:blocked:${page.id}`);

    messages.push({
      text: `🔹 <b>Projekt inaktiv seit ${daysSince} Tagen:</b>\n${title}\n\nNoch relevant?`,
      keyboard,
    });
  }

  // Old pending admin
  for (const page of oldAdmin) {
    const title = summarizePage(page).slice(0, 80);
    const daysSince = Math.floor((Date.now() - new Date(page.created_time).getTime()) / 86400000);

    const keyboard = new InlineKeyboard()
      .text('Erledigt', `review:done:${page.id}`)
      .text('Behalten', `review:keep:${page.id}`)
      .row()
      .text('Abbrechen', `review:cancel:${page.id}`);

    messages.push({
      text: `🔸 <b>Admin-Task offen seit ${daysSince} Tagen:</b>\n${title}\n\nNoch offen?`,
      keyboard,
    });
  }

  // Uncurated ideas
  for (const page of uncuratedIdeas) {
    const title = summarizePage(page).slice(0, 80);
    const daysSince = Math.floor((Date.now() - new Date(page.created_time).getTime()) / 86400000);

    const keyboard = new InlineKeyboard()
      .text('High', `curate:high:${page.id}`)
      .text('Medium', `curate:medium:${page.id}`)
      .row()
      .text('Low', `curate:low:${page.id}`)
      .text('Archivieren', `curate:archive:${page.id}`);

    messages.push({
      text: `💡 <b>Idee bewerten</b> (${daysSince} Tage alt):\n${title}`,
      keyboard,
    });
  }

  // Projects without next action (nudge only, no buttons)
  try {
    const activeProjects = await queryByProperty(config.NOTION_DB_PROJECTS, 'Status', 'active', 10);
    const missingNextAction = activeProjects.filter((p) => {
      const naProp = p.properties['Next Action'] as Record<string, unknown> | undefined;
      if (!naProp || naProp['type'] !== 'rich_text') return true;
      const rt = naProp['rich_text'] as Array<{ plain_text?: string }> | undefined;
      return !rt || rt.length === 0 || rt.every((t) => !t.plain_text?.trim());
    });

    if (missingNextAction.length > 0) {
      const names = missingNextAction
        .slice(0, 3)
        .map((p) => `• ${summarizePage(p).slice(0, 60)}`)
        .join('\n');
      messages.push({
        text: `⚠️ <b>Projekte ohne nächsten Schritt:</b>\n${names}\n\nSchick mir ein Update wie z.B. "Landing Page — als nächstes DNS konfigurieren"`,
      });
    }
  } catch (err) {
    logger.warn({ error: String(err) }, 'Failed to check projects without next action');
  }

  if (messages.length === 0) {
    logger.info({ event: 'weekly_review_skip', reason: 'nothing_to_review', durationMs: Date.now() - startMs });
    return;
  }

  for (const msg of messages) {
    await sendFn(msg.text, msg.keyboard);
  }

  logger.info({
    event: 'weekly_review_sent',
    staleProjects: staleProjects.length,
    oldAdmin: oldAdmin.length,
    uncuratedIdeas: uncuratedIdeas.length,
    durationMs: Date.now() - startMs,
  });
}
