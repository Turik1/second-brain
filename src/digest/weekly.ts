import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { listRecent, getThoughtStats, listOpenTasks } from '../db/index.js';
import { splitTelegramMessage } from '../utils/telegram.js';
import { WEEKLY_DIGEST_SYSTEM_PROMPT } from './prompt.js';
import { formatThoughtsForDigest, formatStatsSection } from './format.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const TOKEN_BUDGET_CHARS = 15000 * 4;

export async function generateWeeklyDigest(
  sendFn: (text: string) => Promise<void>,
): Promise<void> {
  const startMs = Date.now();

  logger.info({ event: 'digest_start', type: 'weekly' });

  const [recentThoughts, stats] = await Promise.all([
    listRecent(7, 200),
    getThoughtStats(7),
  ]);

  if (recentThoughts.length === 0) {
    await sendFn('<b>Weekly Review</b>\n\nNothing captured this week. A blank slate for the week ahead!');
    logger.info({ event: 'digest_sent', type: 'weekly', entriesCount: 0, durationMs: Date.now() - startMs });
    return;
  }

  const openTasks = await listOpenTasks(50);

  const staleTasks = openTasks.filter(t => {
    const age = Date.now() - t.created_at.getTime();
    return age > 7 * 24 * 60 * 60 * 1000;
  });
  let openSection = '';
  if (staleTasks.length > 0) {
    openSection = `\nSTALE OPEN TASKS (${staleTasks.length}, older than 7 days):\n` +
      staleTasks.map(t => `- ${t.title ?? t.content.slice(0, 80)} (${Math.floor((Date.now() - t.created_at.getTime()) / 86400000)} days old)`).join('\n') + '\n';
  }

  const statsSection = formatStatsSection(stats);
  const thoughtsSection = formatThoughtsForDigest(recentThoughts);

  let formattedInput = `${statsSection}${openSection}\n\nTHOUGHTS:\n${thoughtsSection}`;
  if (formattedInput.length > TOKEN_BUDGET_CHARS) {
    formattedInput = formattedInput.slice(0, TOKEN_BUDGET_CHARS) + '\n\n[Input truncated to fit token budget]';
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
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
  logger.info({ event: 'digest_sent', type: 'weekly', entriesCount: recentThoughts.length, durationMs });
}
