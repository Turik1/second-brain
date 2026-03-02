import cron from 'node-cron';
import type { Bot } from 'grammy';
import type { InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { generateDailyDigest } from './daily.js';
import { generateWeeklyDigest } from './weekly.js';
import { generateAfternoonReminder } from './reminder.js';
import { generateWeeklyReview } from './weekly-review.js';
import { cleanupStaleBouncer, cleanupStaleRelations } from '../bot/handlers/message.js';

export function initializeScheduler(
  sendFn: (text: string) => Promise<void>,
  sendWithKeyboardFn: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
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
      try {
        cleanupStaleRelations();
      } catch (err) {
        logger.error({ event: 'relation_cleanup_error', error: err }, 'Relation cleanup failed');
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

  const reviewSchedule = `30 ${config.DAILY_DIGEST_HOUR} * * ${config.WEEKLY_DIGEST_DAY}`;

  const reviewJob = config.WEEKLY_REVIEW_ENABLED
    ? cron.schedule(
        reviewSchedule,
        async () => {
          logger.info({ event: 'cron_fire', type: 'weekly_review' });
          try {
            await generateWeeklyReview(sendWithKeyboardFn);
          } catch (err) {
            logger.error({ event: 'weekly_review_error', error: err }, 'Weekly review failed');
          }
        },
        { timezone },
      )
    : null;

  logger.info(
    {
      dailySchedule,
      weeklySchedule,
      reminderSchedule,
      reviewSchedule,
      timezone,
    },
    `Daily digest scheduled for ${String(config.DAILY_DIGEST_HOUR).padStart(2, '0')}:00 ${timezone}`,
  );

  return {
    stop: () => {
      dailyJob.stop();
      weeklyJob.stop();
      reminderJob.stop();
      reviewJob?.stop();
      logger.info('Digest scheduler stopped');
    },
  };
}
