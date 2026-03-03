import { pool } from './pool.js';
import { logger } from '../utils/logger.js';

const MIGRATION_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS thoughts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  embedding     vector(1024),

  title         TEXT,
  thought_type  TEXT,
  topics        TEXT[],
  people        TEXT[],
  action_items  TEXT[],

  source        TEXT NOT NULL DEFAULT 'telegram',
  source_id     TEXT,
  chat_id       BIGINT,

  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thoughts_embedding_idx ON thoughts USING hnsw (embedding vector_cosine_ops);
CREATE UNIQUE INDEX IF NOT EXISTS thoughts_source_dedup_idx ON thoughts (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS thoughts_created_idx ON thoughts (created_at DESC);
CREATE INDEX IF NOT EXISTS thoughts_type_idx ON thoughts (thought_type);

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS priority VARCHAR(10);

CREATE INDEX IF NOT EXISTS thoughts_status_idx ON thoughts (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS thoughts_due_date_idx ON thoughts (due_date) WHERE due_date IS NOT NULL AND status = 'open';
`;

export async function runMigrations(): Promise<void> {
  logger.info('Running database migrations');
  await pool.query(MIGRATION_SQL);
  logger.info('Database migrations complete');
}
