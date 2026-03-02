import cron from 'node-cron';
import type { Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { generateDailyDigest } from './daily.js';
import { generateWeeklyDigest } from './weekly.js';
import { generateAfternoonReminder } from './reminder.js';
import { cleanupStaleBouncer } from '../bot/handlers/message.js';

export function initializeScheduler(
  sendFn: (text: string) => Promise<void>,
  bot?: Bot,
): { stop: () => void } {
  const dailySchedule = `0 ${config.DAILY_DIGEST_HOUR} * * *`;
  const weeklySchedule = `0 ${config.DAILY_DIGEST_HOUR} * * ${config.WEEKLY_DIGEST_DAY}`;
  const timezone = config.DIGEST_TIMEZONE;

  const dailyJob = cron.schedule(
    dailySchedule,
    async () => {
      logger.info({ event: 'cron_fire', type: 'daily' });
      try {
        await generateDailyDigest(sendFn);
      } catch (err) {
        logger.error({ event: 'digest_error', type: 'daily', error: err }, 'Daily digest failed');
      }
      // Clean up stale bouncer entries (24h expiry)
      if (bot) {
        try {
          await cleanupStaleBouncer(bot);
        } catch (err) {
          logger.error({ event: 'bouncer_cleanup_error', error: err }, 'Bouncer cleanup failed');
        }
      }
    },
    { timezone },
  );

  const weeklyJob = cron.schedule(
    weeklySchedule,
    async () => {
      logger.info({ event: 'cron_fire', type: 'weekly' });
      try {
        await generateWeeklyDigest(sendFn);
      } catch (err) {
        logger.error({ event: 'digest_error', type: 'weekly', error: err }, 'Weekly digest failed');
      }
    },
    { timezone },
  );

  const reminderSchedule = `0 ${config.AFTERNOON_REMINDER_HOUR} * * *`;

  const reminderJob = cron.schedule(
    reminderSchedule,
    async () => {
      logger.info({ event: 'cron_fire', type: 'reminder' });
      try {
        await generateAfternoonReminder(sendFn);
      } catch (err) {
        logger.error({ event: 'reminder_error', error: err }, 'Afternoon reminder failed');
      }
    },
    { timezone },
  );

  logger.info(
    {
      dailySchedule,
      weeklySchedule,
      reminderSchedule,
      timezone,
    },
    `Daily digest scheduled for ${String(config.DAILY_DIGEST_HOUR).padStart(2, '0')}:00 ${timezone}`,
  );

  return {
    stop: () => {
      dailyJob.stop();
      weeklyJob.stop();
      reminderJob.stop();
      logger.info('Digest scheduler stopped');
    },
  };
}
