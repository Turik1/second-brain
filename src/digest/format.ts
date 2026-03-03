import type { Thought } from '../db/index.js';
import type { getThoughtStats } from '../db/index.js';

export function formatThoughtsForDigest(thoughts: Thought[]): string {
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

export function formatStatsSection(
  stats: Awaited<ReturnType<typeof getThoughtStats>>,
  label = 'STATS',
): string {
  const lines: string[] = [`${label}:`];
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
