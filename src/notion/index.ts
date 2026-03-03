import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { NotionError } from '../utils/errors.js';
import type { ClassificationResult, Category } from '../types.js';
import type { InboxLogEntry, NotionPage } from './schemas.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAILED_MESSAGES_PATH = path.resolve(__dirname, '../../data/failed-messages.json');

// Token-bucket rate limiter: enforces minimum 400ms between Notion API calls (2.5 req/s max)
class RateLimiter {
  private lastCallTime = 0;
  private readonly minIntervalMs: number;

  constructor(minIntervalMs = 400) {
    this.minIntervalMs = minIntervalMs;
  }

  async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.minIntervalMs - elapsed),
      );
    }
    this.lastCallTime = Date.now();
  }
}

export interface FailedMessage {
  timestamp: string;
  operation: string;
  payload: unknown;
  error: string;
}

const rateLimiter = new RateLimiter(400);

export const notionClient = new Client({
  auth: config.NOTION_API_KEY,
  notionVersion: '2022-06-28',
});

/**
 * Wrap any Notion API call with rate limiting and error handling.
 * On failure, optionally saves to local fallback file.
 * On success, triggers a backlog drain.
 */
export async function callNotion<T>(
  operation: string,
  fn: () => Promise<T>,
  fallbackPayload?: unknown,
): Promise<T> {
  await rateLimiter.throttle();
  try {
    const result = await fn();
    // On success, try to drain the backlog (non-blocking)
    void drainBacklog();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'notion_error', operation, error: message });
    if (fallbackPayload !== undefined) {
      await saveToFallback(operation, fallbackPayload, message);
    }
    throw new NotionError(`Notion API call failed: ${operation}`, err);
  }
}

async function ensureDataDir(): Promise<void> {
  const dataDir = path.dirname(FAILED_MESSAGES_PATH);
  await fs.mkdir(dataDir, { recursive: true });
}

async function saveToFallback(
  operation: string,
  payload: unknown,
  error: string,
): Promise<void> {
  try {
    await ensureDataDir();
    let existing: FailedMessage[] = [];
    try {
      const content = await fs.readFile(FAILED_MESSAGES_PATH, 'utf-8');
      existing = JSON.parse(content) as FailedMessage[];
    } catch {
      // File doesn't exist yet — start fresh
    }
    existing.push({ timestamp: new Date().toISOString(), operation, payload, error });
    await fs.writeFile(FAILED_MESSAGES_PATH, JSON.stringify(existing, null, 2), 'utf-8');
    logger.warn({ event: 'fallback_saved', operation, total: existing.length });
  } catch (saveErr) {
    logger.error({ event: 'fallback_save_failed', error: String(saveErr) });
  }
}

let draining = false;

/**
 * Attempt to drain the backlog of failed messages.
 * Called automatically after each successful Notion API call.
 * Logs entries so operators can decide how to re-process them.
 */
export async function drainBacklog(): Promise<void> {
  if (draining) return;

  let messages: FailedMessage[] = [];
  try {
    const content = await fs.readFile(FAILED_MESSAGES_PATH, 'utf-8');
    messages = JSON.parse(content) as FailedMessage[];
  } catch {
    return; // No backlog file — nothing to do
  }

  if (messages.length === 0) return;

  draining = true;
  logger.info({ event: 'drain_backlog_start', count: messages.length });

  // Log each pending message so operators / downstream code can re-process
  for (const msg of messages) {
    logger.warn({
      event: 'backlog_entry',
      operation: msg.operation,
      timestamp: msg.timestamp,
      payload: msg.payload,
    });
  }

  // Clear the backlog — entries have been surfaced to logs for re-processing
  try {
    await fs.unlink(FAILED_MESSAGES_PATH);
  } catch (err) {
    logger.error({ event: 'drain_backlog_clear_failed', error: String(err) });
  }

  logger.info({ event: 'drain_backlog_done', drained: messages.length });
  draining = false;
}

export async function getBacklogMessages(): Promise<FailedMessage[]> {
  try {
    const content = await fs.readFile(FAILED_MESSAGES_PATH, 'utf-8');
    return JSON.parse(content) as FailedMessage[];
  } catch {
    return [];
  }
}

// ─── Re-exports ──────────────────────────────────────────────────────────────
// All database operations re-exported so callers only need to import from notion/index.ts

export {
  createPeoplePage,
  createProjectsPage,
  createIdeasPage,
  createAdminPage,
  createInboxLogEntry,
  updateInboxLogStatus,
  queryRecentEntries,
  queryByProperty,
  queryPendingAdmin,
  queryDueAdmin,
  queryAllAdmin,
  queryStaleProjects,
  queryOldPendingAdmin,
  updatePageProperty,
  searchByTitle,
  updatePageStatus,
  updateAdminFromCalendar,
  addRelation,
  moveEntry,
  verifyDatabases,
  summarizePage,
} from './databases.js';

export type { DatabaseVerificationResult } from './databases.js';

export type {
  PeopleEntry,
  ProjectEntry,
  IdeaEntry,
  AdminEntry,
  InboxLogEntry,
  NotionPage,
  DatabaseCategory,
} from './schemas.js';

// Import database functions for use in helper functions below
import {
  createPeoplePage,
  createProjectsPage,
  createIdeasPage,
  createAdminPage,
  updateInboxLogStatus,
  findInboxLogByMessageId as _findInboxLogByMessageId,
} from './databases.js';

// ─── Helper functions used by bot handlers ───────────────────────────────────

/**
 * File a classified message to the appropriate Notion database.
 * Returns the page ID of the created entry.
 */
export async function fileToDatabase(
  classification: ClassificationResult,
  sourceMessage: string,
  telegramMessageId: number,
): Promise<string> {
  const base = {
    tags: classification.tags,
    sourceMessage,
    sourceMessageId: telegramMessageId,
    confidence: classification.confidence,
  };

  const extras = classification.extras;

  switch (classification.category) {
    case 'people':
      return createPeoplePage({
        name: (extras['name'] as string) ?? classification.title,
        relationship:
          (extras['relationship'] as
            | 'friend'
            | 'colleague'
            | 'acquaintance'
            | 'family'
            | 'professional-contact') ?? 'acquaintance',
        context: (extras['context'] as string) ?? classification.summary,
        ...base,
      });

    case 'projects':
      return createProjectsPage({
        name: classification.title,
        status:
          (extras['status'] as
            | 'idea'
            | 'active'
            | 'blocked'
            | 'completed'
            | 'archived') ?? 'active',
        description: (extras['description'] as string) ?? classification.summary,
        priority: (extras['priority'] as 'high' | 'medium' | 'low') ?? 'medium',
        nextAction: (extras['next_action'] as string | null) ?? null,
        ...base,
      });

    case 'ideas':
      return createIdeasPage({
        name: classification.title,
        category:
          (extras['idea_category'] as
            | 'business'
            | 'technical'
            | 'creative'
            | 'personal'
            | 'research') ?? 'personal',
        description: (extras['description'] as string) ?? classification.summary,
        potential:
          (extras['potential'] as 'high' | 'medium' | 'low' | 'unknown') ?? 'unknown',
        ...base,
      });

    case 'admin':
      return createAdminPage({
        name: classification.title,
        type:
          (extras['type'] as
            | 'task'
            | 'reminder'
            | 'appointment'
            | 'errand'
            | 'note') ?? 'task',
        dueDate: (extras['due_date'] as string | null) ?? null,
        status: 'pending',
        priority: (extras['priority'] as 'high' | 'medium' | 'low') ?? 'medium',
        ...base,
      });

    default:
      throw new NotionError(`Unknown category: ${classification.category}`);
  }
}

/**
 * Update an inbox log entry with new status and optional fields.
 */
export async function updateInboxLogEntry(
  pageId: string,
  updates: {
    status?: InboxLogEntry['status'];
    category?: Category;
    confidence?: number;
    notionPageId?: string;
    error?: string;
    processingTimeMs?: number;
  },
): Promise<void> {
  await updateInboxLogStatus(
    pageId,
    updates.status ?? 'processed',
    updates.notionPageId,
    updates.error,
    updates.processingTimeMs,
  );
}

/**
 * Archive a Notion page (soft delete).
 */
export async function archiveNotionPage(pageId: string): Promise<void> {
  await callNotion('archiveNotionPage', () =>
    notionClient.pages.update({
      page_id: pageId,
      archived: true,
      properties: {},
    }),
  );
  logger.info({ event: 'page_archived', pageId });
}

/**
 * Extended inbox log lookup that returns full text and metadata needed by fix/bouncer flows.
 */
export async function findInboxLogByMessageId(
  messageId: number,
): Promise<
  | (NotionPage & {
      fullText: string;
      telegramMessageId: number;
      notionPageId?: string;
      pageId: string;
      title?: string;
    })
  | null
> {
  const page = await _findInboxLogByMessageId(messageId);
  if (!page) return null;

  const props = page.properties;

  function extractText(prop: unknown): string {
    if (!Array.isArray(prop)) return '';
    return (prop as Array<{ plain_text?: string }>)
      .map((t) => t.plain_text ?? '')
      .join('');
  }

  const fullTextProp = props['Full Text'] as Record<string, unknown> | undefined;
  const notionPageIdProp = props['Notion Page ID'] as
    | Record<string, unknown>
    | undefined;
  const titleProp = props['Message'] as Record<string, unknown> | undefined;

  const fullText = fullTextProp?.['rich_text']
    ? extractText(fullTextProp['rich_text'])
    : '';
  const notionPageId = notionPageIdProp?.['rich_text']
    ? extractText(notionPageIdProp['rich_text'])
    : undefined;
  const title = titleProp?.['title']
    ? extractText(titleProp['title'])
    : undefined;

  return {
    ...page,
    pageId: page.id,
    fullText,
    telegramMessageId: messageId,
    notionPageId: notionPageId || undefined,
    title,
  };
}
