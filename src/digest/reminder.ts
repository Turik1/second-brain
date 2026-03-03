import { logger } from '../utils/logger.js';
import { pool } from '../db/index.js';
import type { Thought } from '../db/index.js';

export async function generateAfternoonReminder(sendFn: (text: string) => Promise<void>): Promise<void> {
  const startMs = Date.now();

  logger.info({ event: 'reminder_start' });

  let rows: Thought[];
  try {
    const result = await pool.query<Thought>(
      `SELECT * FROM thoughts
       WHERE thought_type = 'task'
       AND action_items != '{}'
       AND created_at > now() - interval '7 days'
       ORDER BY created_at DESC`,
    );
    rows = result.rows;
  } catch (err) {
    logger.error({ event: 'reminder_error', error: String(err) }, 'Afternoon reminder failed');
    return;
  }

  if (rows.length === 0) {
    logger.info({ event: 'reminder_skip', reason: 'no_due_tasks', durationMs: Date.now() - startMs });
    return;
  }

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const recentItems: string[] = [];
  const olderItems: string[] = [];

  for (const thought of rows) {
    const createdStr = thought.created_at.toISOString().split('T')[0];
    const label = thought.title ?? thought.content.slice(0, 80);
    const actions = thought.action_items.join('; ');
    const summary = `${label} — ${actions}`.slice(0, 150);

    if (createdStr === todayStr) {
      recentItems.push(`• ${summary}`);
    } else {
      const daysAgo = Math.floor((today.getTime() - thought.created_at.getTime()) / 86400000);
      olderItems.push(`• ${summary} (vor ${daysAgo} Tag${daysAgo > 1 ? 'en' : ''})`);
    }
  }

  const lines: string[] = [];
  lines.push(`<b>Reminder: ${recentItems.length} heute, ${olderItems.length} offen</b>`);
  lines.push('');

  if (recentItems.length > 0) {
    lines.push('<b>Heute erfasst:</b>');
    lines.push(...recentItems);
    lines.push('');
  }

  if (olderItems.length > 0) {
    lines.push('<b>Offene Aufgaben:</b>');
    lines.push(...olderItems);
  }

  await sendFn(lines.join('\n'));

  logger.info({
    event: 'reminder_sent',
    todayCount: recentItems.length,
    olderCount: olderItems.length,
    durationMs: Date.now() - startMs,
  });
}
