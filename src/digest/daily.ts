import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { queryRecentEntries, queryPendingAdmin, summarizePage } from '../notion/index.js';
import { splitTelegramMessage } from '../utils/telegram.js';
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

export async function generateDailyDigest(sendFn: (text: string) => Promise<void>): Promise<void> {
  const startMs = Date.now();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  logger.info({ event: 'digest_start', type: 'daily', since });

  const [people, projects, ideas, adminPages] = await Promise.all([
    queryCategory(config.NOTION_DB_PEOPLE, since),
    queryCategory(config.NOTION_DB_PROJECTS, since),
    queryCategory(config.NOTION_DB_IDEAS, since),
    queryPendingAdmin(PAGE_SIZE),
  ]);

  const admin = {
    entries: adminPages.map((p) => summarizePage(p).slice(0, 200)),
    truncated: adminPages.length === PAGE_SIZE,
  };

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
    model: 'claude-sonnet-4-5-20250929',
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
