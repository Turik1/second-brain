import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { queryRecentEntries, summarizePage } from '../notion/index.js';
import { DAILY_DIGEST_SYSTEM_PROMPT } from './prompt.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const PAGE_SIZE = 50;

interface DigestInput {
  people: string[];
  projects: string[];
  ideas: string[];
  admin: string[];
}

async function queryCategory(dbId: string, since: Date): Promise<{ entries: string[]; truncated: boolean }> {
  const pages = await queryRecentEntries(dbId, since, PAGE_SIZE);
  const entries = pages.map((p) => summarizePage(p).slice(0, 200));
  return { entries, truncated: pages.length === PAGE_SIZE };
}

function formatInput(input: DigestInput, truncated: Record<string, boolean>): string {
  const sections: string[] = [];

  for (const [category, entries] of Object.entries(input) as [keyof DigestInput, string[]][]) {
    if (entries.length === 0) {
      sections.push(`## ${category.toUpperCase()}\n(none)`);
    } else {
      const note = truncated[category] ? `\n(${entries.length}+ entries, showing first ${PAGE_SIZE})` : '';
      sections.push(`## ${category.toUpperCase()}\n${entries.map((e) => `• ${e}`).join('\n')}${note}`);
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

    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return parts;
}

export async function generateDailyDigest(sendFn: (text: string) => Promise<void>): Promise<void> {
  const startMs = Date.now();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  logger.info({ event: 'digest_start', type: 'daily', since });

  const [people, projects, ideas, admin] = await Promise.all([
    queryCategory(config.NOTION_DB_PEOPLE, since),
    queryCategory(config.NOTION_DB_PROJECTS, since),
    queryCategory(config.NOTION_DB_IDEAS, since),
    queryCategory(config.NOTION_DB_ADMIN, since),
  ]);

  const totalEntries =
    people.entries.length + projects.entries.length + ideas.entries.length + admin.entries.length;

  if (totalEntries === 0) {
    await sendFn('Nothing captured yesterday. Fresh start today!');
    logger.info({ event: 'digest_sent', type: 'daily', entriesCount: 0, durationMs: Date.now() - startMs });
    return;
  }

  const input: DigestInput = {
    people: people.entries,
    projects: projects.entries,
    ideas: ideas.entries,
    admin: admin.entries,
  };

  const truncated: Record<string, boolean> = {
    people: people.truncated,
    projects: projects.truncated,
    ideas: ideas.truncated,
    admin: admin.truncated,
  };

  // Truncate to ~8K token budget (4 chars/token estimate)
  const TOKEN_BUDGET_CHARS = 8000 * 4;
  let formattedInput = formatInput(input, truncated);
  if (formattedInput.length > TOKEN_BUDGET_CHARS) {
    formattedInput = formattedInput.slice(0, TOKEN_BUDGET_CHARS) + '\n\n[Input truncated to fit token budget]';
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-latest',
    max_tokens: 2048,
    system: DAILY_DIGEST_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: formattedInput }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const digest = textBlock?.type === 'text' ? textBlock.text : 'Could not generate digest.';

  // Split if exceeding Telegram's 4096 char limit
  const parts = splitTelegramMessage(digest);
  for (const part of parts) {
    await sendFn(part);
  }

  const durationMs = Date.now() - startMs;
  logger.info({ event: 'digest_sent', type: 'daily', entriesCount: totalEntries, durationMs });
}
