import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { callNotion, notionClient } from './index.js';
import type {
  PeopleEntry,
  ProjectEntry,
  IdeaEntry,
  AdminEntry,
  InboxLogEntry,
  NotionPage,
} from './schemas.js';

// Helper: build a rich_text property value
function richText(content: string) {
  return [{ type: 'text' as const, text: { content: content.slice(0, 2000) } }];
}

// Helper: build a select property value
function sel(name: string) {
  return { name };
}

// Helper: build a multi_select property value
function multiSelect(tags: string[]) {
  return tags.map((tag) => ({ name: tag.slice(0, 100) }));
}

// Helper: extract plain text from a Notion rich_text or title array
function extractText(prop: unknown): string {
  if (!Array.isArray(prop)) return '';
  return (prop as Array<{ plain_text?: string }>)
    .map((t) => t.plain_text ?? '')
    .join('');
}

// Helper: query a database via the raw Notion REST API (SDK v5 removed databases.query)
interface QueryDatabaseOptions {
  database_id: string;
  filter?: unknown;
  sorts?: Array<{ timestamp?: string; property?: string; direction: string }>;
  page_size?: number;
  start_cursor?: string;
}

interface QueryDatabaseResponse {
  results: Array<{
    id: string;
    properties: Record<string, unknown>;
    created_time: string;
    last_edited_time: string;
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

async function queryDatabase(opts: QueryDatabaseOptions): Promise<QueryDatabaseResponse> {
  const body: Record<string, unknown> = {};
  if (opts.filter) body['filter'] = opts.filter;
  if (opts.sorts) body['sorts'] = opts.sorts;
  if (opts.page_size) body['page_size'] = opts.page_size;
  if (opts.start_cursor) body['start_cursor'] = opts.start_cursor;

  return notionClient.request<QueryDatabaseResponse>({
    path: `databases/${opts.database_id}/query`,
    method: 'post',
    body,
  });
}

// ─── Create functions ────────────────────────────────────────────────────────

export async function createPeoplePage(data: PeopleEntry): Promise<string> {
  const page = await callNotion(
    'createPeoplePage',
    () =>
      notionClient.pages.create({
        parent: { database_id: config.NOTION_DB_PEOPLE },
        properties: {
          Name: { title: richText(data.name) },
          Relationship: { select: sel(data.relationship) },
          Context: { rich_text: richText(data.context) },
          Tags: { multi_select: multiSelect(data.tags) },
          'Source Message': { rich_text: richText(data.sourceMessage) },
          'Source Message ID': { number: data.sourceMessageId },
          Confidence: { number: data.confidence },
        },
      }),
    { operation: 'createPeoplePage', data },
  );
  logger.info({ event: 'page_created', db: 'people', pageId: page.id });
  return page.id;
}

export async function createProjectsPage(data: ProjectEntry): Promise<string> {
  const page = await callNotion(
    'createProjectsPage',
    () =>
      notionClient.pages.create({
        parent: { database_id: config.NOTION_DB_PROJECTS },
        properties: {
          Name: { title: richText(data.name) },
          Status: { select: sel(data.status) },
          Description: { rich_text: richText(data.description) },
          Tags: { multi_select: multiSelect(data.tags) },
          Priority: { select: sel(data.priority) },
          'Source Message': { rich_text: richText(data.sourceMessage) },
          'Source Message ID': { number: data.sourceMessageId },
          Confidence: { number: data.confidence },
        },
      }),
    { operation: 'createProjectsPage', data },
  );
  logger.info({ event: 'page_created', db: 'projects', pageId: page.id });
  return page.id;
}

export async function createIdeasPage(data: IdeaEntry): Promise<string> {
  const page = await callNotion(
    'createIdeasPage',
    () =>
      notionClient.pages.create({
        parent: { database_id: config.NOTION_DB_IDEAS },
        properties: {
          Name: { title: richText(data.name) },
          Category: { select: sel(data.category) },
          Description: { rich_text: richText(data.description) },
          Tags: { multi_select: multiSelect(data.tags) },
          Potential: { select: sel(data.potential) },
          'Source Message': { rich_text: richText(data.sourceMessage) },
          'Source Message ID': { number: data.sourceMessageId },
          Confidence: { number: data.confidence },
        },
      }),
    { operation: 'createIdeasPage', data },
  );
  logger.info({ event: 'page_created', db: 'ideas', pageId: page.id });
  return page.id;
}

export async function createAdminPage(data: AdminEntry): Promise<string> {
  const properties: Record<string, unknown> = {
    Name: { title: richText(data.name) },
    Type: { select: sel(data.type) },
    Status: { select: sel(data.status) },
    Tags: { multi_select: multiSelect(data.tags) },
    'Source Message': { rich_text: richText(data.sourceMessage) },
    'Source Message ID': { number: data.sourceMessageId },
    Confidence: { number: data.confidence },
  };

  if (data.dueDate) {
    properties['Due Date'] = { date: { start: data.dueDate } };
  }

  const page = await callNotion(
    'createAdminPage',
    () =>
      notionClient.pages.create({
        parent: { database_id: config.NOTION_DB_ADMIN },
        properties: properties as Parameters<typeof notionClient.pages.create>[0]['properties'],
      }),
    { operation: 'createAdminPage', data },
  );
  logger.info({ event: 'page_created', db: 'admin', pageId: page.id });
  return page.id;
}

export async function createInboxLogEntry(data: InboxLogEntry): Promise<string> {
  const properties: Record<string, unknown> = {
    Message: { title: richText(data.message.slice(0, 100)) },
    'Full Text': { rich_text: richText(data.fullText) },
    Category: { select: sel(data.category) },
    Status: { select: sel(data.status) },
    Confidence: { number: data.confidence },
    'Telegram Message ID': { number: data.telegramMessageId },
  };

  if (data.notionPageId) {
    properties['Notion Page ID'] = { rich_text: richText(data.notionPageId) };
  }
  if (data.error) {
    properties['Error'] = { rich_text: richText(data.error) };
  }
  if (data.processingTimeMs !== undefined) {
    properties['Processing Time MS'] = { number: data.processingTimeMs };
  }

  const page = await callNotion(
    'createInboxLogEntry',
    () =>
      notionClient.pages.create({
        parent: { database_id: config.NOTION_DB_INBOX_LOG },
        properties: properties as Parameters<typeof notionClient.pages.create>[0]['properties'],
      }),
    { operation: 'createInboxLogEntry', data },
  );
  logger.info({ event: 'inbox_log_created', pageId: page.id, status: data.status });
  return page.id;
}

// ─── Update functions ────────────────────────────────────────────────────────

export async function updateInboxLogStatus(
  pageId: string,
  status: InboxLogEntry['status'],
  notionPageId?: string,
  error?: string,
  processingTimeMs?: number,
): Promise<void> {
  const properties: Record<string, unknown> = {
    Status: { select: sel(status) },
  };

  if (notionPageId) {
    properties['Notion Page ID'] = { rich_text: richText(notionPageId) };
  }
  if (error) {
    properties['Error'] = { rich_text: richText(error) };
  }
  if (processingTimeMs !== undefined) {
    properties['Processing Time MS'] = { number: processingTimeMs };
  }

  await callNotion(
    'updateInboxLogStatus',
    () =>
      notionClient.pages.update({
        page_id: pageId,
        properties: properties as Parameters<typeof notionClient.pages.update>[0]['properties'],
      }),
  );
  logger.info({ event: 'inbox_log_updated', pageId, status });
}

// ─── Query functions ─────────────────────────────────────────────────────────

export async function queryRecentEntries(
  databaseId: string,
  since: Date,
  pageSize = 50,
): Promise<NotionPage[]> {
  const response = await callNotion('queryRecentEntries', () =>
    queryDatabase({
      database_id: databaseId,
      filter: {
        timestamp: 'created_time',
        created_time: { on_or_after: since.toISOString() },
      },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: pageSize,
    }),
  );

  return response.results.map((page) => ({
    id: page.id,
    properties: page.properties,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  }));
}

export async function queryByProperty(
  databaseId: string,
  propertyName: string,
  value: string,
  pageSize = 50,
): Promise<NotionPage[]> {
  const response = await callNotion('queryByProperty', () =>
    queryDatabase({
      database_id: databaseId,
      filter: {
        property: propertyName,
        select: { equals: value },
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: pageSize,
    }),
  );

  return response.results.map((page) => ({
    id: page.id,
    properties: page.properties,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  }));
}

export async function queryPendingAdmin(pageSize = 50): Promise<NotionPage[]> {
  const response = await callNotion('queryPendingAdmin', () =>
    queryDatabase({
      database_id: config.NOTION_DB_ADMIN,
      filter: {
        property: 'Status',
        select: { equals: 'pending' },
      },
      sorts: [
        { property: 'Due Date', direction: 'ascending' },
        { timestamp: 'created_time', direction: 'descending' },
      ],
      page_size: pageSize,
    }),
  );

  return response.results.map((page) => ({
    id: page.id,
    properties: page.properties,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  }));
}

export async function queryDueAdmin(onOrBefore: Date, pageSize = 50): Promise<NotionPage[]> {
  const response = await callNotion('queryDueAdmin', () =>
    queryDatabase({
      database_id: config.NOTION_DB_ADMIN,
      filter: {
        and: [
          { property: 'Status', select: { equals: 'pending' } },
          { property: 'Due Date', date: { on_or_before: onOrBefore.toISOString().split('T')[0] } },
        ],
      },
      sorts: [{ property: 'Due Date', direction: 'ascending' }],
      page_size: pageSize,
    }),
  );

  return response.results.map((page) => ({
    id: page.id,
    properties: page.properties,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  }));
}

export async function findInboxLogByMessageId(
  messageId: number,
): Promise<NotionPage | null> {
  const response = await callNotion('findInboxLogByMessageId', () =>
    queryDatabase({
      database_id: config.NOTION_DB_INBOX_LOG,
      filter: {
        property: 'Telegram Message ID',
        number: { equals: messageId },
      },
      page_size: 1,
    }),
  );

  if (response.results.length === 0) return null;

  const page = response.results[0];
  return {
    id: page.id,
    properties: page.properties,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  };
}

// ─── Search & Update functions ───────────────────────────────────────────────

export async function searchByTitle(
  databaseId: string,
  query: string,
  pageSize = 5,
): Promise<NotionPage[]> {
  const response = await callNotion('searchByTitle', () =>
    queryDatabase({
      database_id: databaseId,
      filter: {
        property: 'Name',
        title: { contains: query },
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: pageSize,
    }),
  );

  return response.results.map((page) => ({
    id: page.id,
    properties: page.properties,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  }));
}

export async function updatePageStatus(
  pageId: string,
  status: string,
): Promise<void> {
  await callNotion('updatePageStatus', () =>
    notionClient.pages.update({
      page_id: pageId,
      properties: {
        Status: { select: sel(status) },
      } as Parameters<typeof notionClient.pages.update>[0]['properties'],
    }),
  );
  logger.info({ event: 'page_status_updated', pageId, status });
}

// ─── Move entry ──────────────────────────────────────────────────────────────

/**
 * "Move" an entry by archiving the old page and creating a new one in the target DB.
 * Notion has no native move API.
 */
export async function moveEntry(
  _fromDbId: string,
  toDbId: string,
  pageId: string,
  newProperties: Record<string, unknown>,
): Promise<string> {
  // Archive the old page
  await callNotion('archivePage', () =>
    notionClient.pages.update({
      page_id: pageId,
      archived: true,
      properties: {},
    }),
  );

  // Create new page in target database
  const newPage = await callNotion('moveEntry_create', () =>
    notionClient.pages.create({
      parent: { database_id: toDbId },
      properties: newProperties as Parameters<typeof notionClient.pages.create>[0]['properties'],
    }),
  );

  logger.info({ event: 'entry_moved', oldPageId: pageId, newPageId: newPage.id, toDbId });
  return newPage.id;
}

// ─── Verify databases ────────────────────────────────────────────────────────

export interface DatabaseVerificationResult {
  db: string;
  id: string;
  ok: boolean;
  error?: string;
}

export async function verifyDatabases(): Promise<DatabaseVerificationResult[]> {
  const databases = [
    { db: 'people', id: config.NOTION_DB_PEOPLE },
    { db: 'projects', id: config.NOTION_DB_PROJECTS },
    { db: 'ideas', id: config.NOTION_DB_IDEAS },
    { db: 'admin', id: config.NOTION_DB_ADMIN },
    { db: 'inbox_log', id: config.NOTION_DB_INBOX_LOG },
  ];

  const results: DatabaseVerificationResult[] = [];

  for (const { db, id } of databases) {
    try {
      await callNotion(`verifyDatabases:${db}`, () =>
        queryDatabase({ database_id: id, page_size: 1 }),
      );
      results.push({ db, id, ok: true });
      logger.info({ event: 'db_verified', db, id });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ db, id, ok: false, error });
      logger.error({ event: 'db_verify_failed', db, id, error });
    }
  }

  return results;
}

// ─── Helper exports for digest ───────────────────────────────────────────────

/**
 * Extract a plain-text summary of a Notion page for digest generation.
 * Returns title + first 200 chars of the first rich_text property found.
 */
export function summarizePage(page: NotionPage): string {
  const props = page.properties;
  let title = '';
  let body = '';
  const meta: string[] = [];

  for (const [key, val] of Object.entries(props)) {
    if (typeof val !== 'object' || val === null) continue;
    const v = val as Record<string, unknown>;

    if (v['type'] === 'title' && Array.isArray(v['title'])) {
      title = extractText(v['title']);
    } else if (v['type'] === 'rich_text' && Array.isArray(v['rich_text']) && !body) {
      const text = extractText(v['rich_text']);
      if (text) body = text.slice(0, 200);
    } else if (v['type'] === 'select' && v['select']) {
      const selectVal = (v['select'] as Record<string, unknown>)['name'] as string | undefined;
      if (selectVal && (key === 'Priority' || key === 'Status')) {
        meta.push(`${key}: ${selectVal}`);
      }
    } else if (v['type'] === 'date' && v['date'] && key === 'Due Date') {
      const dateObj = v['date'] as Record<string, unknown>;
      const start = dateObj['start'] as string | undefined;
      if (start) meta.push(`fällig: ${start}`);
    }
  }

  const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
  return body ? `${title}${metaStr}: ${body}` : `${title}${metaStr}`;
}
