import { logger } from '../utils/logger.js';
import { getOpenTaskStats } from '../db/index.js';

export async function generateAfternoonReminder(sendFn: (text: string) => Promise<void>): Promise<void> {
  const startMs = Date.now();
  logger.info({ event: 'reminder_start' });

  try {
    const stats = await getOpenTaskStats();

    if (stats.open === 0) {
      logger.info({ event: 'reminder_skip', reason: 'no_open_tasks', durationMs: Date.now() - startMs });
      return;
    }

    const lines: string[] = [];
    lines.push(`<b>📋 ${stats.open} offene Aufgaben</b>`);
    if (stats.overdue > 0) lines.push(`⚠️ ${stats.overdue} überfällig`);
    if (stats.dueToday > 0) lines.push(`📅 ${stats.dueToday} fällig heute`);
    lines.push('');
    lines.push('Nutze /open für die vollständige Liste.');

    await sendFn(lines.join('\n'));

    logger.info({
      event: 'reminder_sent',
      open: stats.open,
      overdue: stats.overdue,
      dueToday: stats.dueToday,
      durationMs: Date.now() - startMs,
    });
  } catch (err) {
    logger.error({ event: 'reminder_error', error: String(err) }, 'Afternoon reminder failed');
  }
}
