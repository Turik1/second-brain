import { logger } from '../utils/logger.js';
import { queryDueAdmin, summarizePage } from '../notion/index.js';

export async function generateAfternoonReminder(sendFn: (text: string) => Promise<void>): Promise<void> {
  const startMs = Date.now();
  const today = new Date();

  logger.info({ event: 'reminder_start' });

  let pages;
  try {
    pages = await queryDueAdmin(today);
  } catch (err) {
    logger.error({ event: 'reminder_error', error: String(err) }, 'Afternoon reminder failed');
    return;
  }

  if (pages.length === 0) {
    logger.info({ event: 'reminder_skip', reason: 'no_due_tasks', durationMs: Date.now() - startMs });
    return;
  }

  const todayStr = today.toISOString().split('T')[0];
  const overdue: string[] = [];
  const dueToday: string[] = [];

  for (const page of pages) {
    const summary = summarizePage(page).slice(0, 120);
    const dateProp = page.properties['Due Date'] as Record<string, unknown> | undefined;
    const dateObj = dateProp?.['date'] as Record<string, unknown> | undefined;
    const dueDate = dateObj?.['start'] as string | undefined;

    if (dueDate && dueDate < todayStr) {
      const daysAgo = Math.floor((today.getTime() - new Date(dueDate).getTime()) / 86400000);
      overdue.push(`• ${summary} (seit ${daysAgo} Tag${daysAgo > 1 ? 'en' : ''})`);
    } else {
      dueToday.push(`• ${summary}`);
    }
  }

  const lines: string[] = [];
  lines.push(`⏰ <b>Reminder: ${dueToday.length} heute fällig, ${overdue.length} überfällig</b>`);
  lines.push('');

  if (dueToday.length > 0) {
    lines.push('<b>Heute fällig:</b>');
    lines.push(...dueToday);
    lines.push('');
  }

  if (overdue.length > 0) {
    lines.push('<b>Überfällig:</b>');
    lines.push(...overdue);
  }

  await sendFn(lines.join('\n'));

  logger.info({
    event: 'reminder_sent',
    dueToday: dueToday.length,
    overdue: overdue.length,
    durationMs: Date.now() - startMs,
  });
}
