import { z } from 'zod';

const ConfigSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  ALLOWED_CHAT_ID: z.string().min(1, 'ALLOWED_CHAT_ID is required'),
  WEBHOOK_DOMAIN: z.string().optional(),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // Notion
  NOTION_API_KEY: z.string().min(1, 'NOTION_API_KEY is required'),
  NOTION_PARENT_PAGE_ID: z.string().min(1, 'NOTION_PARENT_PAGE_ID is required'),
  NOTION_DB_PEOPLE: z.string().min(1, 'NOTION_DB_PEOPLE is required'),
  NOTION_DB_PROJECTS: z.string().min(1, 'NOTION_DB_PROJECTS is required'),
  NOTION_DB_IDEAS: z.string().min(1, 'NOTION_DB_IDEAS is required'),
  NOTION_DB_ADMIN: z.string().min(1, 'NOTION_DB_ADMIN is required'),
  NOTION_DB_INBOX_LOG: z.string().min(1, 'NOTION_DB_INBOX_LOG is required'),

  // Postgres
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Embeddings
  VOYAGE_API_KEY: z.string().min(1, 'VOYAGE_API_KEY is required'),

  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production']).default('production'),

  // Digest schedule
  DIGEST_TIMEZONE: z.string().default('Europe/Berlin'),
  DAILY_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  WEEKLY_DIGEST_DAY: z.coerce.number().int().min(0).max(6).default(0),
  AFTERNOON_REMINDER_HOUR: z.coerce.number().int().min(0).max(23).default(14),

  // Classification
  BOUNCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),

  // Weekly review
  WEEKLY_REVIEW_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }
  return result.data;
}

export const config = loadConfig();
