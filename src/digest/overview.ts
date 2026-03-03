import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { splitTelegramMessage } from '../utils/telegram.js';
import { listRecent, getThoughtStats } from '../db/index.js';
import { OVERVIEW_SYSTEM_PROMPT } from './prompt.js';
import { formatThoughtsForDigest, formatStatsSection } from './format.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const TOKEN_BUDGET_CHARS = 8000 * 4;

export async function generateOverview(sendFn: (text: string) => Promise<void>): Promise<void> {
  const startMs = Date.now();

  logger.info({ event: 'digest_start', type: 'overview' });

  const [recentThoughts, stats] = await Promise.all([
    listRecent(30, 100),
    getThoughtStats(30),
  ]);

  if (recentThoughts.length === 0) {
    await sendFn('Your second brain is empty. Start capturing thoughts!');
    logger.info({ event: 'digest_sent', type: 'overview', entriesCount: 0, durationMs: Date.now() - startMs });
    return;
  }

  const statsSection = formatStatsSection(stats, 'STATS (last 30 days)');
  const thoughtsSection = formatThoughtsForDigest(recentThoughts);

  let formattedInput = `${statsSection}\n\nTHOUGHTS:\n${thoughtsSection}`;
  if (formattedInput.length > TOKEN_BUDGET_CHARS) {
    formattedInput = formattedInput.slice(0, TOKEN_BUDGET_CHARS) + '\n\n[Input truncated to fit token budget]';
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2048,
    system: OVERVIEW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: formattedInput }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const overview = textBlock?.type === 'text' ? textBlock.text : 'Could not generate overview.';

  const parts = splitTelegramMessage(overview);
  for (const part of parts) {
    await sendFn(part);
  }

  const durationMs = Date.now() - startMs;
  logger.info({ event: 'digest_sent', type: 'overview', entriesCount: recentThoughts.length, durationMs });
}
