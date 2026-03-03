import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { splitTelegramMessage } from '../utils/telegram.js';
import { listRecent, getThoughtStats } from '../db/index.js';
import type { Thought } from '../db/index.js';
import { OVERVIEW_SYSTEM_PROMPT } from './prompt.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const TOKEN_BUDGET_CHARS = 8000 * 4;

function formatThoughtsForOverview(thoughts: Thought[]): string {
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

function formatStatsSection(stats: Awaited<ReturnType<typeof getThoughtStats>>): string {
  const lines: string[] = ['STATS (last 30 days):'];
  lines.push(`- Total thoughts: ${stats.total}`);

  if (Object.keys(stats.byType).length > 0) {
    const typeParts = Object.entries(stats.byType).map(([type, count]) => `${type} (${count})`);
    lines.push(`- By type: ${typeParts.join(', ')}`);
  }

  if (stats.topTopics.length > 0) {
    const topicParts = stats.topTopics.slice(0, 5).map((t) => `${t.topic} (${t.count})`);
    lines.push(`- Top topics: ${topicParts.join(', ')}`);
  }

  if (stats.topPeople.length > 0) {
    const peopleParts = stats.topPeople.slice(0, 5).map((p) => `${p.person} (${p.count})`);
    lines.push(`- Top people: ${peopleParts.join(', ')}`);
  }

  return lines.join('\n');
}

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

  const statsSection = formatStatsSection(stats);
  const thoughtsSection = formatThoughtsForOverview(recentThoughts);

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
