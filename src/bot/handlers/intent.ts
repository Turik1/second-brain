import { Bot, InlineKeyboard } from 'grammy';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import {
  searchByTitle,
  updatePageStatus,
  updateInboxLogStatus,
  summarizePage,
} from '../../notion/index.js';
import type { ClassificationResult, Category } from '../../types.js';
import type { NotionPage } from '../../notion/index.js';

// ─── In-memory map for disambiguation callbacks ─────────────────────────────
// Telegram callback_data has a 64-byte limit, so we store full IDs in memory
// and use a short numeric key in the callback data.

interface PendingIntent {
  inboxLogPageId: string;
  targetPageId: string;
  action: 'done' | 'update';
  category: Category;
  title: string;
  timestamp: number;
}

let nextIntentKey = 1;
const pendingIntentMap = new Map<number, PendingIntent>();

const INTENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ─── DB ID helper (shared with fix.ts pattern) ──────────────────────────────

function getTargetDbId(category: Category): string {
  switch (category) {
    case 'people':
      return config.NOTION_DB_PEOPLE;
    case 'projects':
      return config.NOTION_DB_PROJECTS;
    case 'ideas':
      return config.NOTION_DB_IDEAS;
    case 'admin':
    default:
      return config.NOTION_DB_ADMIN;
  }
}

// ─── Progressive search: full query first, then individual words ─────────────

async function progressiveSearch(dbId: string, query: string): Promise<NotionPage[]> {
  // Try full query first
  let pages = await searchByTitle(dbId, query, 5);
  if (pages.length > 0) return pages;

  // Try individual words (longest first, skip short words)
  const words = query.split(/\s+/).filter((w) => w.length >= 3);
  words.sort((a, b) => b.length - a.length);

  for (const word of words) {
    pages = await searchByTitle(dbId, word, 5);
    if (pages.length > 0) return pages;
  }

  return [];
}

// ─── Done status per category ────────────────────────────────────────────────

function getDoneStatus(category: Category): string | null {
  switch (category) {
    case 'projects':
      return 'completed';
    case 'admin':
      return 'done';
    default:
      return null; // people and ideas have no done state
  }
}

// ─── Handle "done" intent ────────────────────────────────────────────────────

export async function handleDoneIntent(
  ctx: any,
  classification: ClassificationResult,
  text: string,
  messageId: number,
  inboxLogPageId: string,
  startTime: number,
): Promise<boolean> {
  const { category, searchQuery } = classification;

  // Validate category supports "done"
  const doneStatus = getDoneStatus(category);
  if (!doneStatus) {
    await ctx.reply(
      `Die Kategorie "${category}" hat keinen "erledigt"-Status. ` +
        'Das geht nur bei Projects und Admin. Ich lege stattdessen einen neuen Eintrag an.',
    );
    return false;
  }

  if (!searchQuery) {
    logger.warn({ event: 'done_no_search_query', messageId });
    await ctx.reply(
      'Ich konnte nicht erkennen, welcher Eintrag erledigt ist. Ich lege einen neuen Eintrag an.',
    );
    return false;
  }

  const dbId = getTargetDbId(category);

  let pages;
  try {
    pages = await progressiveSearch(dbId, searchQuery);
  } catch (err) {
    logger.error({ event: 'intent_search_failed', messageId, error: String(err) });
    await ctx.reply('Fehler bei der Suche. Ich lege stattdessen einen neuen Eintrag an.');
    return false;
  }

  if (pages.length === 0) {
    await ctx.reply(
      `Ich konnte keinen Eintrag mit "${searchQuery}" finden. ` +
        'Die Nachricht wird als neuer Eintrag angelegt.',
    );
    return false;
  }

  if (pages.length === 1) {
    // Single match — mark as done directly
    await markAsDone(ctx, pages[0].id, summarizePage(pages[0]), doneStatus, inboxLogPageId, messageId, startTime);
    return true;
  }

  // Multiple matches — show disambiguation keyboard
  const keyboard = new InlineKeyboard();
  for (const page of pages) {
    const title = summarizePage(page).slice(0, 40);
    const key = nextIntentKey++;
    pendingIntentMap.set(key, {
      inboxLogPageId,
      targetPageId: page.id,
      action: 'done',
      category,
      title,
      timestamp: Date.now(),
    });
    keyboard.text(title, `i:${key}`).row();
  }

  await ctx.reply('Mehrere Einträge gefunden. Welchen meinst du?', {
    reply_markup: keyboard,
  });
  return true;
}

// ─── Handle "update" intent ──────────────────────────────────────────────────

export async function handleUpdateIntent(
  ctx: any,
  classification: ClassificationResult,
  text: string,
  messageId: number,
  inboxLogPageId: string,
  startTime: number,
): Promise<boolean> {
  const { category, searchQuery } = classification;

  if (!searchQuery) {
    logger.warn({ event: 'update_no_search_query', messageId });
    await ctx.reply(
      'Ich konnte nicht erkennen, welcher Eintrag aktualisiert werden soll. Ich lege einen neuen Eintrag an.',
    );
    return false;
  }

  const dbId = getTargetDbId(category);

  let pages;
  try {
    pages = await progressiveSearch(dbId, searchQuery);
  } catch (err) {
    logger.error({ event: 'intent_search_failed', messageId, error: String(err) });
    await ctx.reply('Fehler bei der Suche. Ich lege stattdessen einen neuen Eintrag an.');
    return false;
  }

  if (pages.length === 0) {
    await ctx.reply(
      `Ich konnte keinen Eintrag mit "${searchQuery}" finden. ` +
        'Die Nachricht wird als neuer Eintrag angelegt.',
    );
    return false;
  }

  if (pages.length === 1) {
    await applyUpdate(ctx, pages[0].id, summarizePage(pages[0]), classification, inboxLogPageId, messageId, startTime);
    return true;
  }

  // Multiple matches — disambiguation
  const keyboard = new InlineKeyboard();
  for (const page of pages) {
    const title = summarizePage(page).slice(0, 40);
    const key = nextIntentKey++;
    pendingIntentMap.set(key, {
      inboxLogPageId,
      targetPageId: page.id,
      action: 'update',
      category,
      title,
      timestamp: Date.now(),
    });
    keyboard.text(title, `i:${key}`).row();
  }

  await ctx.reply('Mehrere Einträge gefunden. Welchen meinst du?', {
    reply_markup: keyboard,
  });
  return true;
}

// ─── Core actions ────────────────────────────────────────────────────────────

async function markAsDone(
  ctx: any,
  pageId: string,
  pageTitle: string,
  doneStatus: string,
  inboxLogPageId: string,
  messageId: number,
  startTime: number,
): Promise<void> {
  try {
    await updatePageStatus(pageId, doneStatus);
  } catch (err) {
    logger.error({ event: 'done_update_failed', messageId, pageId, error: String(err) });
    await ctx.reply('Fehler beim Aktualisieren. Bitte versuche es nochmal.');
    return;
  }

  try {
    await updateInboxLogStatus(inboxLogPageId, 'processed', pageId, undefined, Date.now() - startTime);
  } catch (err) {
    logger.warn({ messageId, error: String(err) }, 'Failed to update inbox log after done');
  }

  const shortTitle = pageTitle.slice(0, 60);
  await ctx.reply(`✅ Erledigt: ${shortTitle}`, {
    reply_parameters: { message_id: messageId },
  });

  logger.info({ event: 'intent_done', messageId, pageId, doneStatus });
}

async function applyUpdate(
  ctx: any,
  pageId: string,
  pageTitle: string,
  classification: ClassificationResult,
  inboxLogPageId: string,
  messageId: number,
  startTime: number,
): Promise<void> {
  // For updates: update the Status if the classifier extracted a new status
  const newStatus = classification.extras['status'] as string | undefined;
  if (newStatus) {
    try {
      await updatePageStatus(pageId, newStatus);
    } catch (err) {
      logger.error({ event: 'update_status_failed', messageId, pageId, error: String(err) });
      await ctx.reply('Fehler beim Aktualisieren. Bitte versuche es nochmal.');
      return;
    }
  }

  try {
    await updateInboxLogStatus(inboxLogPageId, 'processed', pageId, undefined, Date.now() - startTime);
  } catch (err) {
    logger.warn({ messageId, error: String(err) }, 'Failed to update inbox log after update');
  }

  const shortTitle = pageTitle.slice(0, 60);
  const detail = newStatus ? ` (Status: ${newStatus})` : '';
  await ctx.reply(`📝 Aktualisiert: ${shortTitle}${detail}`, {
    reply_parameters: { message_id: messageId },
  });

  logger.info({ event: 'intent_update', messageId, pageId, newStatus });
}

// ─── Register callback handler for disambiguation ───────────────────────────

export function registerIntentCallbackHandler(bot: Bot): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('i:')) return;

    const key = parseInt(data.slice(2), 10);
    await ctx.answerCallbackQuery();

    const pending = pendingIntentMap.get(key);
    if (!pending) {
      await ctx.reply('Dieser Eintrag ist abgelaufen. Bitte schick die Nachricht nochmal.');
      return;
    }

    pendingIntentMap.delete(key);

    const startTime = pending.timestamp;

    if (pending.action === 'done') {
      const doneStatus = getDoneStatus(pending.category);
      if (doneStatus) {
        await markAsDone(
          ctx,
          pending.targetPageId,
          pending.title,
          doneStatus,
          pending.inboxLogPageId,
          0,
          startTime,
        );
      }
    } else if (pending.action === 'update') {
      // For disambiguation callback, we just confirm the selection with a status update receipt
      await ctx.reply(`📝 Aktualisiert: ${pending.title}`);
      try {
        await updateInboxLogStatus(pending.inboxLogPageId, 'processed', pending.targetPageId);
      } catch (err) {
        logger.warn({ error: String(err) }, 'Failed to update inbox log after disambiguation');
      }
    }
  });
}

// ─── Cleanup stale intent entries ────────────────────────────────────────────

export function cleanupStaleIntents(): void {
  const now = Date.now();
  for (const [key, entry] of pendingIntentMap.entries()) {
    if (now - entry.timestamp > INTENT_EXPIRY_MS) {
      pendingIntentMap.delete(key);
    }
  }
}
