import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { queryRecentEntries, summarizePage } from '../notion/index.js';
import { WEEKLY_DIGEST_SYSTEM_PROMPT } from './prompt.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const PAGE_SIZE = 50;
const MAX_TOKENS_ESTIMATE = 15000;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKENS_ESTIMATE * CHARS_PER_TOKEN;

async function queryCategory(dbId: string, since: Date): Promise<{ entries: string[]; truncated: boolean }> {
  const pages = await queryRecentEntries(dbId, since, PAGE_SIZE);
  const entries = pages.map((p) => summarizePage(p).slice(0, 200));
  return { entries, truncated: pages.length === PAGE_SIZE };
}

async function queryInboxStats(since: Date): Promise<Record<string, number>> {
  const pages = await queryRecentEntries(config.NOTION_DB_INBOX_LOG, since, PAGE_SIZE);
  const counts: Record<string, number> = { processed: 0, failed: 0, 're-classified': 0, pending: 0, expired: 0 };
  for (const page of pages) {
    const statusProp = page.properties['Status'] as Record<string, unknown> | undefined;
    if (statusProp?.['type'] === 'select') {
      const sel = statusProp['select'] as Record<string, unknown> | null;
      const name = sel?.['name'] as string | undefined;
      if (name && name in counts) counts[name]++;
    }
  }
  return counts;
}

function formatWeeklyInput(
  categories: Record<string, { entries: string[]; truncated: boolean }>,
  inboxStats?: Record<string, number>,
): string {
  const sections: string[] = [];
  let totalChars = 0;

  for (const [category, { entries, truncated }] of Object.entries(categories)) {
    if (entries.length === 0) {
      sections.push(`## ${category.toUpperCase()}\n(none)`);
      continue;
    }

    const lines: string[] = [];
    for (const entry of entries) {
      const line = `• ${entry}`;
      if (totalChars + line.length > MAX_CHARS) {
        lines.push('(older entries omitted due to length limit)');
        break;
      }
      lines.push(line);
      totalChars += line.length;
    }

    const note = truncated ? `\n(showing first ${PAGE_SIZE} entries)` : '';
    sections.push(`## ${category.toUpperCase()}\n${lines.join('\n')}${note}`);
  }

  if (inboxStats) {
    const statLines = Object.entries(inboxStats)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `• ${status}: ${count}`)
      .join('\n');
    if (statLines) {
      sections.push(`## INBOX LOG STATS\n${statLines}`);
    }
  }

  return sections.join('\n\n');
}

function splitTelegramMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    // Split at last newline before limit
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return parts;
}

export async function generateWeeklyDigest(
  sendFn: (text: string) => Promise<void>,
): Promise<void> {
  const startMs = Date.now();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  logger.info({ event: 'digest_start', type: 'weekly', since });

  const [people, projects, ideas, admin, inboxStats] = await Promise.all([
    queryCategory(config.NOTION_DB_PEOPLE, since),
    queryCategory(config.NOTION_DB_PROJECTS, since),
    queryCategory(config.NOTION_DB_IDEAS, since),
    queryCategory(config.NOTION_DB_ADMIN, since),
    queryInboxStats(since),
  ]);

  const totalEntries =
    people.entries.length + projects.entries.length + ideas.entries.length + admin.entries.length;

  if (totalEntries === 0) {
    await sendFn('<b>Weekly Review</b>\n\nNothing captured this week. A blank slate for the week ahead!');
    logger.info({ event: 'digest_sent', type: 'weekly', entriesCount: 0, durationMs: Date.now() - startMs });
    return;
  }

  const formattedInput = formatWeeklyInput({ people, projects, ideas, admin }, inboxStats);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-latest',
    max_tokens: 4096,
    system: WEEKLY_DIGEST_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: formattedInput }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const digest = textBlock?.type === 'text' ? textBlock.text : 'Could not generate weekly digest.';

  const parts = splitTelegramMessage(digest);
  for (const part of parts) {
    await sendFn(part);
  }

  const durationMs = Date.now() - startMs;
  logger.info({ event: 'digest_sent', type: 'weekly', entriesCount: totalEntries, durationMs });
}
