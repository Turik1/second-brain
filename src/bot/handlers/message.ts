import { Bot, InlineKeyboard } from 'grammy';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { classify } from '../../classifier/index.js';
import {
  createInboxLogEntry,
  updateInboxLogStatus,
  findInboxLogByMessageId,
  fileToDatabase,
  searchByTitle,
  summarizePage,
  addRelation,
} from '../../notion/index.js';
import {
  checkRateLimit,
  incrementPending,
  decrementPending,
  markMessageProcessed,
} from '../../utils/state.js';
import type { ClassificationResult, Category } from '../../types.js';
import { handleDoneIntent, handleUpdateIntent } from './intent.js';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';

// In-memory map of pending bouncer callbacks: inboxLogPageId -> { originalMessageId, timestamp }
interface PendingBouncer {
  originalMessageId: number;
  timestamp: number;
}
const pendingBouncerMap = new Map<string, PendingBouncer>();

// In-memory map of pending relation callbacks: numeric key -> relation details
interface PendingRelation {
  sourcePageId: string;
  targetPageId: string;
  targetCategory: string;
  timestamp: number;
}

let nextRelationKey = 1;
const pendingRelationMap = new Map<number, PendingRelation>();

// Bouncer stale cleanup: mark pending entries older than 24h as expired
const BOUNCER_EXPIRY_MS = 24 * 60 * 60 * 1000;

export async function cleanupStaleBouncer(bot: Bot): Promise<void> {
  const now = Date.now();
  const expired: string[] = [];

  for (const [inboxLogPageId, entry] of pendingBouncerMap.entries()) {
    if (now - entry.timestamp > BOUNCER_EXPIRY_MS) {
      expired.push(inboxLogPageId);
    }
  }

  for (const inboxLogPageId of expired) {
    const entry = pendingBouncerMap.get(inboxLogPageId)!;
    pendingBouncerMap.delete(inboxLogPageId);

    // Mark inbox log entry as expired
    try {
      await updateInboxLogStatus(inboxLogPageId, 'expired');
      logger.info({ event: 'bouncer_expired', inboxLogPageId, originalMessageId: entry.originalMessageId });
    } catch (err) {
      logger.warn({ inboxLogPageId, error: String(err) }, 'Failed to mark bouncer entry as expired');
    }

    // Notify user
    try {
      await bot.api.sendMessage(
        config.ALLOWED_CHAT_ID,
        `A message from ${new Date(entry.timestamp).toLocaleString()} was not categorized and has expired. Please resend it if still relevant.`,
      );
    } catch (err) {
      logger.warn({ error: String(err) }, 'Failed to send bouncer expiry notification');
    }
  }
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

  // Handle text messages (main pipeline)
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;

    // Skip commands — let command handlers deal with them
    if (text.startsWith('/')) {
      await next();
      return;
    }

    const messageId = ctx.message.message_id;
    const chatId = ctx.chat.id;
    const chatIdStr = chatId.toString();
    const startTime = Date.now();

    // Rate limiting check
    if (!checkRateLimit(chatIdStr)) {
      logger.warn({ event: 'rate_limited', chatId, messageId });
      await ctx.reply("Slow down! I'm processing your previous messages.");
      return;
    }

    logger.info({ event: 'message_received', chatId, messageId, text_length: text.length });

    // Deduplication: check if we already processed this message ID
    try {
      const existing = await findInboxLogByMessageId(messageId);
      if (existing) {
        logger.info({ event: 'duplicate_skipped', messageId }, 'Duplicate message detected, skipping');
        return;
      }
    } catch (err) {
      // Non-fatal: if dedup check fails, proceed with processing
      logger.warn({ messageId, error: String(err) }, 'Deduplication check failed, proceeding anyway');
    }

    incrementPending();

    try {
      // Step 1: Log to Inbox with status "pending"
      let inboxLogPageId: string;
      try {
        inboxLogPageId = await createInboxLogEntry({
          message: text.substring(0, 100),
          fullText: text,
          category: 'unknown',
          status: 'pending',
          confidence: 0,
          telegramMessageId: messageId,
        });
      } catch (err) {
        logger.error({ event: 'error', messageId, stage: 'inbox_log', error: String(err) });
        await ctx.reply(
          "Something went wrong filing this. I've logged it and you can retry by sending the message again.",
        );
        return;
      }

      // Step 2: Classify
      let classification: ClassificationResult;
      try {
        const classifyStart = Date.now();
        classification = await classify(text);
        const durationMs = Date.now() - classifyStart;
        logger.info({
          event: 'classified',
          messageId,
          category: classification.category,
          confidence: classification.confidence,
          durationMs,
        });
      } catch (err) {
        logger.error({ event: 'error', messageId, stage: 'classify', error: String(err) });
        await updateInboxLogStatus(inboxLogPageId, 'failed', undefined, String(err)).catch(() => {});
        await ctx.reply(
          "Something went wrong filing this. I've logged it and you can retry by sending the message again.",
        );
        return;
      }

      // Step 3: Route by intent (update/done bypass bouncer)
      if (classification.intent === 'done') {
        const handled = await handleDoneIntent(ctx, classification, text, messageId, inboxLogPageId, startTime);
        if (handled) return;
        // Not handled — fall through to file as new entry
      }

      if (classification.intent === 'update') {
        const handled = await handleUpdateIntent(ctx, classification, text, messageId, inboxLogPageId, startTime);
        if (handled) return;
        // Not handled — fall through to file as new entry
      }

      // Step 4: Check confidence threshold (BOUNCER FLOW)
      if (classification.confidence < config.BOUNCE_THRESHOLD) {
        pendingBouncerMap.set(inboxLogPageId, { originalMessageId: messageId, timestamp: Date.now() });

        const keyboard = new InlineKeyboard()
          .text('People', `bounce:${inboxLogPageId}:people`)
          .text('Projects', `bounce:${inboxLogPageId}:projects`)
          .row()
          .text('Ideas', `bounce:${inboxLogPageId}:ideas`)
          .text('Admin', `bounce:${inboxLogPageId}:admin`);

        await ctx.reply(
          `I'm not sure where to file this (confidence: ${Math.round(classification.confidence * 100)}%). Where should it go?`,
          { reply_markup: keyboard },
        );
        return;
      }

      // Step 4: File and send receipt
      await fileAndReceipt(ctx, text, messageId, inboxLogPageId, classification, startTime);
    } finally {
      decrementPending();
    }
  });

  // Handle bouncer callback queries
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Handle relation callbacks
    if (data.startsWith('rel:') && !data.startsWith('rel-skip:')) {
      const key = parseInt(data.slice(4), 10);
      const pending = pendingRelationMap.get(key);
      if (!pending) {
        await ctx.answerCallbackQuery();
        await ctx.reply('Dieser Vorschlag ist abgelaufen.');
        return;
      }
      pendingRelationMap.delete(key);
      await ctx.answerCallbackQuery();

      const RELATION_PROPERTY: Record<string, string> = {
        people: 'Related People',
        projects: 'Related Projects',
        ideas: 'Related Ideas',
        admin: 'Related Admin',
      };
      const propName = RELATION_PROPERTY[pending.targetCategory];
      if (propName) {
        try {
          await addRelation(pending.sourcePageId, propName, pending.targetPageId);
          await ctx.editMessageText(
            `${ctx.callbackQuery.message?.text ?? ''}\n\n→ ✓ Verknüpft`,
            { parse_mode: 'HTML' },
          );
          logger.info({ event: 'relation_created', sourcePageId: pending.sourcePageId, targetPageId: pending.targetPageId, targetCategory: pending.targetCategory });
        } catch (err) {
          logger.error({ event: 'relation_failed', error: String(err) });
          await ctx.reply('Fehler beim Verknüpfen.');
        }
      }
      return;
    }

    if (data.startsWith('rel-skip:')) {
      const key = parseInt(data.slice(9), 10);
      pendingRelationMap.delete(key);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `${ctx.callbackQuery.message?.text ?? ''}\n\n→ Übersprungen`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (!data.startsWith('bounce:')) return;

    const parts = data.split(':');
    if (parts.length !== 3) return;

    const [, inboxLogPageId, categoryStr] = parts;
    const category = categoryStr as Category;

    await ctx.answerCallbackQuery();

    const pending = pendingBouncerMap.get(inboxLogPageId);
    if (!pending) {
      await ctx.reply('Could not find the original entry. Please resend the message.');
      return;
    }

    const { originalMessageId } = pending;

    // Look up the full text from Notion inbox log using enriched lookup
    let inboxPage;
    try {
      inboxPage = await findInboxLogByMessageId(originalMessageId);
    } catch (err) {
      logger.error({ event: 'error', stage: 'bouncer_lookup', error: String(err) });
      await ctx.reply('Could not find the original entry. Please resend the message.');
      return;
    }

    if (!inboxPage) {
      await ctx.reply('Could not find the original entry. Please resend the message.');
      return;
    }

    pendingBouncerMap.delete(inboxLogPageId);

    const fullText = inboxPage.fullText || '';

    const forcedClassification: ClassificationResult = {
      category,
      confidence: 1.0,
      title: inboxPage.title || fullText.substring(0, 60),
      summary: fullText,
      tags: [],
      extras: {},
      intent: 'new',
      searchQuery: null,
      relatedEntries: [],
    };

    incrementPending();
    try {
      const startTime = Date.now();
      await fileAndReceiptDirect(
        ctx,
        fullText,
        originalMessageId,
        inboxLogPageId,
        forcedClassification,
        startTime,
      );
    } finally {
      decrementPending();
    }
  });
}

async function fileAndReceipt(
  ctx: any,
  text: string,
  messageId: number,
  inboxLogPageId: string,
  classification: ClassificationResult,
  startTime: number,
): Promise<void> {
  let targetPageId: string;
  try {
    const fileStart = Date.now();
    targetPageId = await fileToDatabase(classification, text, messageId);
    const durationMs = Date.now() - fileStart;
    logger.info({
      event: 'filed',
      messageId,
      category: classification.category,
      notionPageId: targetPageId,
      durationMs,
    });
  } catch (err) {
    logger.error({ event: 'error', messageId, stage: 'file_to_database', error: String(err) });
    try {
      await updateInboxLogStatus(inboxLogPageId, 'failed', undefined, String(err));
    } catch {
      await writeFallback(text, messageId, String(err));
    }
    await ctx.reply(
      "Something went wrong filing this. I've logged it and you can retry by sending the message again.",
    );
    return;
  }

  try {
    await updateInboxLogStatus(
      inboxLogPageId,
      'processed',
      targetPageId,
      undefined,
      Date.now() - startTime,
    );
  } catch (err) {
    logger.warn({ messageId, error: String(err) }, 'Failed to update inbox log after filing');
  }

  markMessageProcessed();

  await ctx.reply(buildReceipt(classification, messageId), {
    parse_mode: 'HTML',
    reply_parameters: { message_id: messageId },
  });

  try {
    await suggestRelations(ctx, classification, targetPageId);
  } catch (err) {
    logger.warn({ event: 'relation_suggestion_failed', error: String(err) });
  }
}

async function fileAndReceiptDirect(
  ctx: any,
  text: string,
  messageId: number,
  inboxLogPageId: string,
  classification: ClassificationResult,
  startTime: number,
): Promise<void> {
  let targetPageId: string;
  try {
    targetPageId = await fileToDatabase(classification, text, messageId);
    logger.info({
      event: 'filed',
      messageId,
      category: classification.category,
      notionPageId: targetPageId,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    logger.error({ event: 'error', messageId, stage: 'bouncer_file', error: String(err) });
    try {
      await updateInboxLogStatus(inboxLogPageId, 'failed', undefined, String(err));
    } catch {
      await writeFallback(text, messageId, String(err));
    }
    await ctx.reply(
      "Something went wrong filing this. I've logged it and you can retry by sending the message again.",
    );
    return;
  }

  try {
    await updateInboxLogStatus(
      inboxLogPageId,
      'processed',
      targetPageId,
      undefined,
      Date.now() - startTime,
    );
  } catch (err) {
    logger.warn({ messageId, error: String(err) }, 'Failed to update inbox log after bouncer filing');
  }

  markMessageProcessed();

  await ctx.reply(buildReceipt(classification, messageId), { parse_mode: 'HTML' });
}

const DB_MAP: Record<string, string> = {
  people: config.NOTION_DB_PEOPLE,
  projects: config.NOTION_DB_PROJECTS,
  ideas: config.NOTION_DB_IDEAS,
  admin: config.NOTION_DB_ADMIN,
};

const CATEGORY_LABELS_FULL: Record<string, string> = {
  people: 'Kontakte',
  projects: 'Projekte',
  ideas: 'Ideen',
  admin: 'Admin',
};

async function suggestRelations(
  ctx: any,
  classification: ClassificationResult,
  sourcePageId: string,
): Promise<void> {
  if (!classification.relatedEntries || classification.relatedEntries.length === 0) return;

  for (const entry of classification.relatedEntries) {
    if (entry.target_category === classification.category) continue;

    const dbId = DB_MAP[entry.target_category];
    if (!dbId) continue;

    try {
      const results = await searchByTitle(dbId, entry.search_query, 3);

      if (results.length === 1) {
        const targetTitle = summarizePage(results[0]).slice(0, 60);
        const targetCategoryLabel = CATEGORY_LABELS_FULL[entry.target_category] ?? entry.target_category;

        const relKey = nextRelationKey++;
        pendingRelationMap.set(relKey, {
          sourcePageId,
          targetPageId: results[0].id,
          targetCategory: entry.target_category,
          timestamp: Date.now(),
        });

        const keyboard = new InlineKeyboard()
          .text('Verknüpfen', `rel:${relKey}`)
          .text('Ignorieren', `rel-skip:${relKey}`);

        await ctx.reply(
          `🔗 Verknüpfung erkannt:\n→ ${targetTitle} (${targetCategoryLabel})\n<i>${entry.relationship}</i>`,
          { parse_mode: 'HTML', reply_markup: keyboard },
        );
      }
    } catch (err) {
      logger.warn({ event: 'relation_search_failed', query: entry.search_query, error: String(err) });
    }
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  people: 'Kontakte',
  projects: 'Projekte',
  ideas: 'Ideen',
  admin: 'Admin',
};

function buildReceipt(classification: ClassificationResult, messageId: number): string {
  const tags = classification.tags?.map((t) => `#${t}`).join(' ') ?? '';
  const confidence = Math.round(classification.confidence * 100);
  const categoryLabel = CATEGORY_LABELS[classification.category] ?? classification.category;

  return (
    `📁 ${categoryLabel}: ${classification.title}\n` +
    (tags ? `Tags: ${tags}\n` : '') +
    `Konfidenz: ${confidence}%\n` +
    `[ref:${messageId}]`
  );
}

async function writeFallback(text: string, messageId: number, error: string): Promise<void> {
  try {
    const dataDir = join(process.cwd(), 'data');
    await mkdir(dataDir, { recursive: true });
    const file = join(dataDir, 'failed-messages.json');
    let existing: unknown[] = [];
    try {
      const content = await readFile(file, 'utf8');
      existing = JSON.parse(content);
    } catch {
      // file doesn't exist yet
    }
    existing.push({ text, messageId, error, timestamp: new Date().toISOString() });
    await writeFile(file, JSON.stringify(existing, null, 2));
    logger.warn({ messageId }, 'Message written to local fallback file');
  } catch (fallbackErr) {
    logger.error({ messageId, error: String(fallbackErr) }, 'Failed to write fallback file');
  }
}
