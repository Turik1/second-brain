import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { listRecent } from '../db/index.js';
import type { Thought } from '../db/index.js';
import { splitTelegramMessage } from '../utils/telegram.js';
import { DAILY_DIGEST_SYSTEM_PROMPT } from './prompt.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

function formatThoughtsForDigest(thoughts: Thought[]): string {
  if (thoughts.length === 0) return '';

  const byType = new Map<string, Thought[]>();
  for (const t of thoughts) {
    const type = t.thought_type ?? 'other';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(t);
  }

  const sections: string[] = [];
  for (const [type, items] of byType) {
    const header = type.toUpperCase().replace('_', ' ');
    const entries = items.map((t) => {
      const parts = [`- ${t.title ?? t.content.slice(0, 80)}`];
      if (t.topics?.length) parts.push(`  Topics: ${t.topics.join(', ')}`);
      if (t.people?.length) parts.push(`  People: ${t.people.join(', ')}`);
      if (t.action_items?.length) parts.push(`  Action items: ${t.action_items.join('; ')}`);
      return parts.join('\n');
    });
    sections.push(`${header} (${items.length}):\n${entries.join('\n')}`);
  }

  return sections.join('\n\n');
}

export async function generateDailyDigest(sendFn: (text: string) => Promise<void>): Promise<void> {
  const startMs = Date.now();

  logger.info({ event: 'digest_start', type: 'daily' });

  const recentThoughts = await listRecent(1, 100);

  if (recentThoughts.length === 0) {
    await sendFn('Nothing captured yesterday. Fresh start today!');
    logger.info({ event: 'digest_sent', type: 'daily', entriesCount: 0, durationMs: Date.now() - startMs });
    return;
  }

  // Truncate to ~8K token budget (4 chars/token estimate)
  const TOKEN_BUDGET_CHARS = 8000 * 4;
  let formattedInput = formatThoughtsForDigest(recentThoughts);
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
  logger.info({ event: 'digest_sent', type: 'daily', entriesCount: recentThoughts.length, durationMs });
}
