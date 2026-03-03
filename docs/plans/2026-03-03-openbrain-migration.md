# Open Brain Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate from Notion-backed second brain to flat Postgres+pgvector Open Brain with MCP server for cross-tool semantic search.

**Architecture:** Single `thoughts` table with Voyage AI embeddings (1024 dims) stored in self-hosted Postgres+pgvector. Telegram bot captures thoughts via embed+extract pipeline. MCP server on Express enables any AI client to search/write. Digests rebuilt on Postgres queries + Claude Sonnet.

**Tech Stack:** Postgres 16 + pgvector, `pg` (node-postgres), `@modelcontextprotocol/sdk`, Voyage AI embeddings (HTTP), Claude Haiku for metadata extraction, existing Express + Caddy + Docker Compose.

**Design doc:** `docs/plans/2026-03-03-openbrain-migration-design.md`

---

## Phase 1 — Infrastructure + Drop CalDAV

### Task 1: Remove CalDAV module

**Files:**
- Delete: `src/caldav/` (entire directory — router.ts, cache.ts, handlers.ts, ical.ts, auth.ts, xml.ts, notion-helpers.ts, and all .test.ts files)
- Modify: `src/index.ts:7,10,88-99` (remove CalDAV imports and mount)
- Modify: `src/config.ts:35-46` (remove CalDAV env vars)
- Modify: `src/utils/state.ts:40-50` (remove CalDAV invalidation)
- Modify: `src/bot/handlers/message.ts` (remove invalidateCaldavCache calls)
- Modify: `docker-compose.yml:10-12` (remove CalDAV env vars)
- Modify: `.env.example` (remove CalDAV section)

**Step 1: Delete the CalDAV directory**

```bash
rm -rf src/caldav/
```

**Step 2: Remove CalDAV from src/index.ts**

Remove the import on line 10:
```typescript
import { createCaldavRouter } from './caldav/index.js';
```

Remove `setCaldavInvalidator` from the state import on line 7.

Remove the CalDAV block (lines 88-99):
```typescript
  // CalDAV server for iOS Calendar integration
  if (config.CALDAV_ENABLED) {
    ...
  }
```

**Step 3: Remove CalDAV config from src/config.ts**

Remove these 3 fields from ConfigSchema (lines 35-46):
```typescript
  CALDAV_ENABLED: z.string().default('false').transform((v) => v !== 'false'),
  CALDAV_USERNAME: z.string().optional(),
  CALDAV_PASSWORD: z.string().optional(),
```

**Step 4: Remove CalDAV state from src/utils/state.ts**

Remove the `setCaldavInvalidator` and `invalidateCaldavCache` functions (lines 40-50) and the `_caldavInvalidator` variable.

**Step 5: Remove invalidateCaldavCache from message handler**

In `src/bot/handlers/message.ts`, remove the import and all calls to `invalidateCaldavCache()`.

**Step 6: Clean up docker-compose.yml and .env.example**

Remove CalDAV env vars from docker-compose.yml (lines 10-12) and the CalDAV section from .env.example.

**Step 7: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 8: Commit**

```bash
git add -A && git commit -m "refactor: remove CalDAV module"
```

---

### Task 2: Add Postgres+pgvector to Docker Compose

**Files:**
- Modify: `docker-compose.yml` (add postgres service, volume, depends_on)
- Modify: `.env.example` (add DATABASE_URL)

**Step 1: Add postgres service to docker-compose.yml**

After the `app` service, add:

```yaml
  postgres:
    image: pgvector/pgvector:pg16
    container_name: second-brain-db
    restart: unless-stopped
    environment:
      - POSTGRES_DB=openbrain
      - POSTGRES_USER=${POSTGRES_USER:-openbrain}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    expose:
      - "5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-openbrain} -d openbrain"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - web
```

Add `pgdata:` to the `volumes:` section.

Add `depends_on` to the `app` service:

```yaml
    depends_on:
      postgres:
        condition: service_healthy
```

**Step 2: Add env vars to .env.example**

```bash
# Postgres (Open Brain)
DATABASE_URL=postgresql://openbrain:changeme@postgres:5432/openbrain
POSTGRES_PASSWORD=changeme
```

**Step 3: Commit**

```bash
git add docker-compose.yml .env.example && git commit -m "infra: add Postgres+pgvector to Docker Compose"
```

---

### Task 3: Create database module

**Files:**
- Create: `src/db/pool.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/queries.ts`
- Create: `src/db/index.ts`
- Create: `src/db/__tests__/queries.test.ts`
- Modify: `src/config.ts` (add DATABASE_URL)

**Step 1: Add DATABASE_URL to config**

In `src/config.ts`, add to ConfigSchema:

```typescript
  // Postgres
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
```

**Step 2: Install pg dependency**

```bash
npm install pg && npm install -D @types/pg
```

**Step 3: Create src/db/pool.ts**

```typescript
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ error: err }, 'Unexpected Postgres pool error');
});

export async function closePool(): Promise<void> {
  await pool.end();
}
```

**Step 4: Create src/db/migrate.ts**

```typescript
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
`;

export async function runMigrations(): Promise<void> {
  logger.info('Running database migrations');
  await pool.query(MIGRATION_SQL);
  logger.info('Database migrations complete');
}
```

Note: Using HNSW instead of IVFFlat from the design doc — HNSW works better for small datasets (no training step required, better recall at low row counts).

**Step 5: Create src/db/queries.ts**

```typescript
import { pool } from './pool.js';

export interface Thought {
  id: string;
  content: string;
  title: string | null;
  thought_type: string | null;
  topics: string[];
  people: string[];
  action_items: string[];
  source: string;
  source_id: string | null;
  chat_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface ThoughtInsert {
  content: string;
  embedding: number[];
  title?: string;
  thought_type?: string;
  topics?: string[];
  people?: string[];
  action_items?: string[];
  source?: string;
  source_id?: string;
  chat_id?: number;
}

export async function insertThought(data: ThoughtInsert): Promise<Thought> {
  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, embedding, title, thought_type, topics, people, action_items, source, source_id, chat_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      data.content,
      JSON.stringify(data.embedding),
      data.title ?? null,
      data.thought_type ?? null,
      data.topics ?? [],
      data.people ?? [],
      data.action_items ?? [],
      data.source ?? 'telegram',
      data.source_id ?? null,
      data.chat_id ?? null,
    ]
  );
  return rows[0];
}

export async function searchThoughts(
  queryEmbedding: number[],
  limit = 10,
  thoughtType?: string
): Promise<(Thought & { similarity: number })[]> {
  const typeFilter = thoughtType ? 'AND thought_type = $3' : '';
  const params: unknown[] = [JSON.stringify(queryEmbedding), limit];
  if (thoughtType) params.push(thoughtType);

  const { rows } = await pool.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM thoughts
     WHERE embedding IS NOT NULL ${typeFilter}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    params
  );
  return rows;
}

export async function listRecent(
  days = 7,
  limit = 20,
  thoughtType?: string
): Promise<Thought[]> {
  const typeFilter = thoughtType ? 'AND thought_type = $3' : '';
  const params: unknown[] = [days, limit];
  if (thoughtType) params.push(thoughtType);

  const { rows } = await pool.query(
    `SELECT * FROM thoughts
     WHERE created_at > now() - make_interval(days => $1) ${typeFilter}
     ORDER BY created_at DESC
     LIMIT $2`,
    params
  );
  return rows;
}

export async function getThoughtStats(days = 30): Promise<{
  total: number;
  byType: Record<string, number>;
  topTopics: { topic: string; count: number }[];
  topPeople: { person: string; count: number }[];
}> {
  const totalResult = await pool.query(
    `SELECT count(*) FROM thoughts WHERE created_at > now() - make_interval(days => $1)`,
    [days]
  );

  const typeResult = await pool.query(
    `SELECT thought_type, count(*) FROM thoughts
     WHERE created_at > now() - make_interval(days => $1) AND thought_type IS NOT NULL
     GROUP BY thought_type ORDER BY count DESC`,
    [days]
  );

  const topicsResult = await pool.query(
    `SELECT topic, count(*) FROM thoughts,
     unnest(topics) AS topic
     WHERE created_at > now() - make_interval(days => $1)
     GROUP BY topic ORDER BY count DESC LIMIT 10`,
    [days]
  );

  const peopleResult = await pool.query(
    `SELECT person, count(*) FROM thoughts,
     unnest(people) AS person
     WHERE created_at > now() - make_interval(days => $1)
     GROUP BY person ORDER BY count DESC LIMIT 10`,
    [days]
  );

  return {
    total: parseInt(totalResult.rows[0].count),
    byType: Object.fromEntries(typeResult.rows.map((r) => [r.thought_type, parseInt(r.count)])),
    topTopics: topicsResult.rows.map((r) => ({ topic: r.topic, count: parseInt(r.count) })),
    topPeople: peopleResult.rows.map((r) => ({ person: r.person, count: parseInt(r.count) })),
  };
}
```

**Step 6: Create src/db/index.ts**

```typescript
export { pool, closePool } from './pool.js';
export { runMigrations } from './migrate.js';
export { insertThought, searchThoughts, listRecent, getThoughtStats } from './queries.js';
export type { Thought, ThoughtInsert } from './queries.js';
```

**Step 7: Write test for queries**

Create `src/db/__tests__/queries.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { ThoughtInsert } from '../queries.js';

describe('ThoughtInsert validation', () => {
  it('should have required content field', () => {
    const thought: ThoughtInsert = {
      content: 'Test thought',
      embedding: new Array(1024).fill(0),
    };
    expect(thought.content).toBe('Test thought');
    expect(thought.embedding).toHaveLength(1024);
  });

  it('should allow optional metadata fields', () => {
    const thought: ThoughtInsert = {
      content: 'Meeting with Sarah about the project',
      embedding: new Array(1024).fill(0),
      title: 'Sarah meeting',
      thought_type: 'meeting',
      topics: ['project', 'design'],
      people: ['Sarah'],
      action_items: ['Send spec by Friday'],
      source: 'telegram',
      source_id: '12345',
      chat_id: 67890,
    };
    expect(thought.thought_type).toBe('meeting');
    expect(thought.people).toContain('Sarah');
  });
});
```

**Step 8: Run test**

Run: `npm test -- src/db/__tests__/queries.test.ts`
Expected: PASS

**Step 9: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 10: Commit**

```bash
git add -A && git commit -m "feat(db): add Postgres connection pool, migrations, and query layer"
```

---

### Task 4: Create embeddings module (Voyage AI)

**Files:**
- Create: `src/embeddings/voyage.ts`
- Create: `src/embeddings/index.ts`
- Create: `src/embeddings/__tests__/voyage.test.ts`
- Modify: `src/config.ts` (add VOYAGE_API_KEY)

**Step 1: Add VOYAGE_API_KEY to config**

In `src/config.ts`, add to ConfigSchema:

```typescript
  // Embeddings
  VOYAGE_API_KEY: z.string().min(1, 'VOYAGE_API_KEY is required'),
```

Add to `.env.example`:
```bash
# Voyage AI (embeddings)
VOYAGE_API_KEY=your-voyage-api-key
```

**Step 2: Create src/embeddings/voyage.ts**

```typescript
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';

export async function generateEmbedding(
  text: string,
  inputType: 'document' | 'query' = 'document'
): Promise<number[]> {
  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input: [text],
      input_type: inputType,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error({ status: response.status, body }, 'Voyage API error');
    throw new Error(`Voyage API error: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    data: { embedding: number[] }[];
  };

  return data.data[0].embedding;
}
```

**Step 3: Create src/embeddings/index.ts**

```typescript
export { generateEmbedding } from './voyage.js';
```

**Step 4: Write test**

Create `src/embeddings/__tests__/voyage.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('generateEmbedding', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('should call Voyage API with correct parameters', async () => {
    const mockEmbedding = new Array(1024).fill(0.1);
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: mockEmbedding }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    // Dynamic import to avoid config validation at module load
    const { generateEmbedding } = await import('../voyage.js');
    const result = await generateEmbedding('test text');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('voyage-3'),
      })
    );
    expect(result).toHaveLength(1024);
  });
});
```

Note: This test may need adjustments depending on how config validation interacts with vitest. If config throws on missing env vars, you may need to set them in a vitest setup file or use `vi.mock('../config.js')`.

**Step 5: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add -A && git commit -m "feat(embeddings): add Voyage AI embedding generation"
```

---

### Task 5: Create metadata extraction utility

**Files:**
- Create: `src/extractor/extract.ts`
- Create: `src/extractor/index.ts`
- Create: `src/extractor/__tests__/extract.test.ts`

**Step 1: Create src/extractor/extract.ts**

This replaces the complex classification system with a simpler metadata extraction call.

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const ThoughtMetadataSchema = z.object({
  title: z.string().max(80),
  thought_type: z.enum([
    'task', 'person_note', 'idea', 'project', 'insight', 'decision', 'meeting',
  ]),
  topics: z.array(z.string()).max(5),
  people: z.array(z.string()),
  action_items: z.array(z.string()),
});

export type ThoughtMetadata = z.infer<typeof ThoughtMetadataSchema>;

const SYSTEM_PROMPT = `Du bist ein Metadaten-Extraktor. Analysiere die Nachricht und extrahiere strukturierte Metadaten.

Regeln:
- title: Kurze Zusammenfassung (max 80 Zeichen), auf Deutsch
- thought_type: Wähle die passendste Kategorie:
  - task: Aufgaben, Erinnerungen, Termine, Erledigungen
  - person_note: Notizen über Personen, Treffen, Kontakte
  - idea: Ideen, Konzepte, kreative Gedanken
  - project: Projektbezogene Notizen, Fortschritt, Meilensteine
  - insight: Erkenntnisse, Learnings, Aha-Momente
  - decision: Entscheidungen mit Kontext
  - meeting: Meeting-Notizen, Gesprächszusammenfassungen
- topics: Bis zu 5 relevante Themen-Tags (kurze Wörter)
- people: Alle erwähnten Personennamen
- action_items: Konkrete nächste Schritte oder Aufgaben (leer wenn keine)`;

export async function extractMetadata(content: string): Promise<ThoughtMetadata> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn({ content, response: text }, 'No JSON in extraction response, using defaults');
    return {
      title: content.slice(0, 80),
      thought_type: 'insight',
      topics: [],
      people: [],
      action_items: [],
    };
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return ThoughtMetadataSchema.parse(parsed);
}
```

Note: We use the same Haiku model the classifier already uses. The prompt is in German to match the bot's language. We ask for JSON output and parse it with Zod. If parsing fails, we fall back to sensible defaults.

**Step 2: Create src/extractor/index.ts**

```typescript
export { extractMetadata } from './extract.js';
export type { ThoughtMetadata } from './extract.js';
```

**Step 3: Write test**

Create `src/extractor/__tests__/extract.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Test the schema validation independently of the API call
const ThoughtMetadataSchema = z.object({
  title: z.string().max(80),
  thought_type: z.enum([
    'task', 'person_note', 'idea', 'project', 'insight', 'decision', 'meeting',
  ]),
  topics: z.array(z.string()).max(5),
  people: z.array(z.string()),
  action_items: z.array(z.string()),
});

describe('ThoughtMetadata schema', () => {
  it('should validate a complete metadata object', () => {
    const result = ThoughtMetadataSchema.parse({
      title: 'Meeting mit Sarah über Redesign',
      thought_type: 'meeting',
      topics: ['design', 'redesign', 'frontend'],
      people: ['Sarah'],
      action_items: ['API-Spec bis Freitag schicken'],
    });
    expect(result.thought_type).toBe('meeting');
    expect(result.people).toContain('Sarah');
  });

  it('should reject invalid thought_type', () => {
    expect(() =>
      ThoughtMetadataSchema.parse({
        title: 'Test',
        thought_type: 'invalid',
        topics: [],
        people: [],
        action_items: [],
      })
    ).toThrow();
  });

  it('should reject title over 80 chars', () => {
    expect(() =>
      ThoughtMetadataSchema.parse({
        title: 'a'.repeat(81),
        thought_type: 'task',
        topics: [],
        people: [],
        action_items: [],
      })
    ).toThrow();
  });
});
```

**Step 4: Run test**

Run: `npm test -- src/extractor/__tests__/extract.test.ts`
Expected: PASS

**Step 5: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add -A && git commit -m "feat(extractor): add Claude Haiku metadata extraction"
```

---

## Phase 2 — Dual Write

### Task 6: Create thought storage pipeline

**Files:**
- Create: `src/brain/store.ts`
- Create: `src/brain/index.ts`

This is the core pipeline: content → parallel(embed, extract) → insert.

**Step 1: Create src/brain/store.ts**

```typescript
import { generateEmbedding } from '../embeddings/index.js';
import { extractMetadata } from '../extractor/index.js';
import { insertThought } from '../db/index.js';
import { logger } from '../utils/logger.js';
import type { Thought } from '../db/index.js';

export interface CaptureInput {
  content: string;
  source?: string;
  source_id?: string;
  chat_id?: number;
}

export async function captureThought(input: CaptureInput): Promise<Thought | null> {
  try {
    const [embedding, metadata] = await Promise.all([
      generateEmbedding(input.content, 'document'),
      extractMetadata(input.content),
    ]);

    const thought = await insertThought({
      content: input.content,
      embedding,
      title: metadata.title,
      thought_type: metadata.thought_type,
      topics: metadata.topics,
      people: metadata.people,
      action_items: metadata.action_items,
      source: input.source ?? 'telegram',
      source_id: input.source_id,
      chat_id: input.chat_id,
    });

    logger.info(
      { thoughtId: thought?.id, type: metadata.thought_type, title: metadata.title },
      'Thought captured'
    );

    return thought;
  } catch (err) {
    logger.error({ error: err, content: input.content.slice(0, 100) }, 'Failed to capture thought');
    return null;
  }
}
```

**Step 2: Create src/brain/index.ts**

```typescript
export { captureThought } from './store.js';
export type { CaptureInput } from './store.js';
```

**Step 3: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add -A && git commit -m "feat(brain): add thought capture pipeline (embed + extract + insert)"
```

---

### Task 7: Wire message handler to dual-write

**Files:**
- Modify: `src/bot/handlers/message.ts` (add Postgres write after Notion write)
- Modify: `src/index.ts` (run migrations on startup)

**Step 1: Add migration to startup in src/index.ts**

After the `logger.info` on line 15, add:

```typescript
import { runMigrations } from './db/index.js';
```

At the top of `main()`, after the logger.info call:

```typescript
  await runMigrations();
```

**Step 2: Add dual-write to message handler**

In `src/bot/handlers/message.ts`, add import at top:

```typescript
import { captureThought } from '../../brain/index.js';
```

In the `fileAndReceipt` function (around line 334), after the successful Notion write and receipt send, add a fire-and-forget Postgres write:

```typescript
    // Dual-write to Postgres (fire-and-forget during migration)
    captureThought({
      content: messageText,
      source: 'telegram',
      source_id: String(telegramMessageId),
      chat_id: Number(config.ALLOWED_CHAT_ID),
    }).catch((err) => {
      logger.error({ error: err }, 'Postgres dual-write failed (non-blocking)');
    });
```

Add the same pattern in `fileAndReceiptDirect` (the bouncer callback path, around line 395) after the Notion write succeeds.

**Step 3: Add closePool to graceful shutdown in src/index.ts**

Import `closePool`:
```typescript
import { runMigrations, closePool } from './db/index.js';
```

In the `shutdown` function, before `process.exit(0)`:
```typescript
    await closePool();
```

**Step 4: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: dual-write Telegram captures to Postgres alongside Notion"
```

---

## Phase 3 — MCP Server

### Task 8: Add MCP server with search and list tools

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/auth.ts`
- Create: `src/mcp/index.ts`
- Modify: `package.json` (add @modelcontextprotocol/sdk)
- Modify: `src/config.ts` (add MCP_ACCESS_KEY)

**Step 1: Install MCP SDK**

```bash
npm install @modelcontextprotocol/sdk
```

**Step 2: Add MCP_ACCESS_KEY to config**

In `src/config.ts`, add:

```typescript
  // MCP
  MCP_ACCESS_KEY: z.string().min(1, 'MCP_ACCESS_KEY is required'),
```

Add to `.env.example`:
```bash
# MCP Server
MCP_ACCESS_KEY=generate-a-random-secret-here
```

**Step 3: Create src/mcp/auth.ts**

```typescript
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

export function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const brainKey = req.headers['x-brain-key'] as string | undefined;

  const token =
    authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : brainKey;

  if (token !== config.MCP_ACCESS_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
```

**Step 4: Create src/mcp/server.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchThoughts, listRecent, getThoughtStats } from '../db/index.js';
import { captureThought } from '../brain/index.js';
import { generateEmbedding } from '../embeddings/index.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'open-brain',
    version: '1.0.0',
  });

  server.tool(
    'search_thoughts',
    'Semantic search across all captured thoughts. Finds thoughts by meaning, not just keywords.',
    {
      query: z.string().describe('Search query — describe what you are looking for'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
      thought_type: z.string().optional().describe('Filter by type: task, person_note, idea, project, insight, decision, meeting'),
    },
    async ({ query, limit, thought_type }) => {
      const queryEmbedding = await generateEmbedding(query, 'query');
      const results = await searchThoughts(queryEmbedding, limit, thought_type);

      const formatted = results.map((r) => [
        `**${r.title ?? 'Untitled'}** (${r.thought_type ?? 'unknown'}, ${(r.similarity * 100).toFixed(0)}% match)`,
        r.content,
        r.topics?.length ? `Topics: ${r.topics.join(', ')}` : '',
        r.people?.length ? `People: ${r.people.join(', ')}` : '',
        r.action_items?.length ? `Action items: ${r.action_items.join('; ')}` : '',
        `Captured: ${r.created_at.toISOString().slice(0, 10)}`,
      ].filter(Boolean).join('\n'));

      return {
        content: [{
          type: 'text' as const,
          text: results.length
            ? formatted.join('\n\n---\n\n')
            : 'No matching thoughts found.',
        }],
      };
    }
  );

  server.tool(
    'list_recent',
    'List recently captured thoughts, optionally filtered by type.',
    {
      days: z.number().int().min(1).max(90).default(7).describe('Look back N days'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max results'),
      thought_type: z.string().optional().describe('Filter by type'),
    },
    async ({ days, limit, thought_type }) => {
      const results = await listRecent(days, limit, thought_type);

      const formatted = results.map((r) => [
        `**${r.title ?? 'Untitled'}** (${r.thought_type ?? 'unknown'})`,
        r.content,
        `Captured: ${r.created_at.toISOString().slice(0, 10)}`,
      ].join('\n'));

      return {
        content: [{
          type: 'text' as const,
          text: results.length
            ? formatted.join('\n\n---\n\n')
            : `No thoughts captured in the last ${days} days.`,
        }],
      };
    }
  );

  server.tool(
    'thought_stats',
    'Get statistics about captured thoughts: counts by type, top topics, top people.',
    {
      days: z.number().int().min(1).max(365).default(30).describe('Look back N days'),
    },
    async ({ days }) => {
      const stats = await getThoughtStats(days);

      const lines = [
        `**Thoughts captured (last ${days} days):** ${stats.total}`,
        '',
        '**By type:**',
        ...Object.entries(stats.byType).map(([type, count]) => `- ${type}: ${count}`),
        '',
        '**Top topics:**',
        ...stats.topTopics.map((t) => `- ${t.topic} (${t.count})`),
        '',
        '**Top people:**',
        ...stats.topPeople.map((p) => `- ${p.person} (${p.count})`),
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  server.tool(
    'capture_thought',
    'Save a new thought to the Open Brain. The thought will be embedded and metadata will be extracted automatically.',
    {
      content: z.string().min(1).describe('The thought to capture'),
      source: z.string().default('mcp').describe('Source identifier (e.g., "claude-desktop", "claude-code")'),
    },
    async ({ content, source }) => {
      const thought = await captureThought({ content, source });

      if (!thought) {
        return {
          content: [{ type: 'text' as const, text: 'Failed to capture thought. Check server logs.' }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Thought captured:`,
            `- Title: ${thought.title ?? 'Untitled'}`,
            `- Type: ${thought.thought_type ?? 'unknown'}`,
            `- Topics: ${thought.topics?.join(', ') || 'none'}`,
            `- People: ${thought.people?.join(', ') || 'none'}`,
          ].join('\n'),
        }],
      };
    }
  );

  return server;
}
```

**Step 5: Create src/mcp/index.ts**

```typescript
export { createMcpServer } from './server.js';
export { mcpAuth } from './auth.js';
```

**Step 6: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add -A && git commit -m "feat(mcp): add MCP server with search, list, stats, and capture tools"
```

---

### Task 9: Mount MCP on Express + update Caddy

**Files:**
- Modify: `src/index.ts` (mount MCP endpoint)
- Modify: `Caddyfile` (ensure /mcp is proxied)

**Step 1: Mount MCP server in src/index.ts**

Add imports:

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, mcpAuth } from './mcp/index.js';
```

After the health endpoint and before the webhook/long-polling setup, add:

```typescript
  // MCP server for AI client access
  const mcpServer = createMcpServer();

  app.all('/mcp', mcpAuth, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on('close', () => { transport.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });

  app.get('/mcp', mcpAuth, async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed. Use POST for MCP requests.' }));
  });

  app.delete('/mcp', mcpAuth, async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed.' }));
  });
```

Note: The MCP SDK's StreamableHTTPServerTransport may need adjustments based on the exact version of the SDK. The key is: POST requests get routed to the transport handler, GET/DELETE return 405. Check the SDK docs for the exact Express integration pattern — the above is the general shape, and you may need to adjust the transport construction and request handling.

**Step 2: Caddyfile is already fine**

The Caddyfile already does `reverse_proxy app:3000` for all paths, so `/mcp` is automatically proxied. No changes needed.

**Step 3: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 4: Test manually**

After deploying, test with curl:
```bash
# Should return 401 without auth
curl -X POST https://your-domain/mcp

# Should work with auth (MCP initialize request)
curl -X POST https://your-domain/mcp \
  -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(mcp): mount MCP server on Express at /mcp"
```

---

## Phase 4 — Notion Data Migration

### Task 10: Write Notion → Postgres migration script

**Files:**
- Create: `scripts/migrate-notion.ts`

**Step 1: Create the migration script**

```typescript
import 'dotenv/config';
import { Client } from '@notionhq/client';
import { config } from '../src/config.js';
import { captureThought } from '../src/brain/index.js';
import { runMigrations } from '../src/db/index.js';
import { closePool } from '../src/db/index.js';

const notion = new Client({ auth: config.NOTION_API_KEY });

const DATABASES = [
  { id: config.NOTION_DB_PEOPLE, category: 'people' },
  { id: config.NOTION_DB_PROJECTS, category: 'projects' },
  { id: config.NOTION_DB_IDEAS, category: 'ideas' },
  { id: config.NOTION_DB_ADMIN, category: 'admin' },
];

function extractTitle(page: any): string {
  const titleProp = Object.values(page.properties).find(
    (p: any) => p.type === 'title'
  ) as any;
  return titleProp?.title?.map((t: any) => t.plain_text).join('') ?? 'Untitled';
}

function extractRichText(page: any, propName: string): string {
  const prop = page.properties[propName];
  if (!prop || prop.type !== 'rich_text') return '';
  return prop.rich_text.map((t: any) => t.plain_text).join('');
}

function extractSelect(page: any, propName: string): string {
  const prop = page.properties[propName];
  if (!prop || prop.type !== 'select' || !prop.select) return '';
  return prop.select.name;
}

function extractMultiSelect(page: any, propName: string): string[] {
  const prop = page.properties[propName];
  if (!prop || prop.type !== 'multi_select') return [];
  return prop.multi_select.map((s: any) => s.name);
}

function extractDate(page: any, propName: string): string {
  const prop = page.properties[propName];
  if (!prop || prop.type !== 'date' || !prop.date) return '';
  return prop.date.start;
}

function pageToContent(page: any, category: string): string {
  const title = extractTitle(page);
  const parts = [title];

  switch (category) {
    case 'people': {
      const relationship = extractSelect(page, 'Relationship');
      const context = extractRichText(page, 'Context');
      if (relationship) parts.push(`Beziehung: ${relationship}`);
      if (context) parts.push(context);
      break;
    }
    case 'projects': {
      const status = extractSelect(page, 'Status');
      const description = extractRichText(page, 'Description');
      const priority = extractSelect(page, 'Priority');
      const nextAction = extractRichText(page, 'Next Action');
      if (status) parts.push(`Status: ${status}`);
      if (priority) parts.push(`Priorität: ${priority}`);
      if (description) parts.push(description);
      if (nextAction) parts.push(`Nächster Schritt: ${nextAction}`);
      break;
    }
    case 'ideas': {
      const ideaCategory = extractSelect(page, 'Category');
      const description = extractRichText(page, 'Description');
      const potential = extractSelect(page, 'Potential');
      if (ideaCategory) parts.push(`Kategorie: ${ideaCategory}`);
      if (potential) parts.push(`Potenzial: ${potential}`);
      if (description) parts.push(description);
      break;
    }
    case 'admin': {
      const type = extractSelect(page, 'Type');
      const status = extractSelect(page, 'Status');
      const priority = extractSelect(page, 'Priority');
      const dueDate = extractDate(page, 'Due Date');
      if (type) parts.push(`Typ: ${type}`);
      if (status) parts.push(`Status: ${status}`);
      if (priority) parts.push(`Priorität: ${priority}`);
      if (dueDate) parts.push(`Fällig: ${dueDate}`);
      break;
    }
  }

  const tags = extractMultiSelect(page, 'Tags');
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}`);

  return parts.join('. ');
}

async function fetchAllPages(databaseId: string): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;

  do {
    const response: any = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;

    // Rate limit: Notion allows ~3 req/s
    await new Promise((r) => setTimeout(r, 400));
  } while (cursor);

  return pages;
}

async function main() {
  console.log('Running migrations...');
  await runMigrations();

  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const { id, category } of DATABASES) {
    console.log(`\nFetching ${category} from Notion...`);
    const pages = await fetchAllPages(id);
    console.log(`Found ${pages.length} ${category} entries`);

    for (const page of pages) {
      const content = pageToContent(page, category);
      const result = await captureThought({
        content,
        source: 'migration',
        source_id: page.id,
      });

      if (result) {
        totalMigrated++;
        process.stdout.write('.');
      } else {
        // null means dedup (already exists) or error
        totalSkipped++;
        process.stdout.write('s');
      }

      // Rate limit for Voyage API
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`\n\nMigration complete:`);
  console.log(`  Migrated: ${totalMigrated}`);
  console.log(`  Skipped:  ${totalSkipped}`);
  console.log(`  Failed:   ${totalFailed}`);

  await closePool();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

**Step 2: Run the script**

```bash
npx tsx scripts/migrate-notion.ts
```

Expected: Dots printed as pages are migrated, final count summary.

**Step 3: Verify**

Connect to Postgres and check:
```bash
docker exec -it second-brain-db psql -U openbrain -d openbrain -c "SELECT count(*), source FROM thoughts GROUP BY source;"
```

Expected: Rows with source='migration' matching your Notion entry counts.

**Step 4: Spot-check semantic search**

Test via MCP or direct query:
```bash
docker exec -it second-brain-db psql -U openbrain -d openbrain -c "SELECT title, thought_type FROM thoughts WHERE source='migration' LIMIT 10;"
```

**Step 5: Commit**

```bash
git add scripts/migrate-notion.ts && git commit -m "feat: add Notion-to-Postgres migration script"
```

---

## Phase 5 — Rebuild Digests

### Task 11: Rewrite daily digest on Postgres

**Files:**
- Modify: `src/digest/daily.ts` (replace Notion queries with Postgres queries)

**Step 1: Rewrite src/digest/daily.ts**

Replace the Notion query logic with Postgres queries. The new flow:

1. Query `thoughts` from last 24h, grouped by thought_type
2. Query thoughts with thought_type='task' and action_items not empty (for pending items)
3. Format and send to Claude Sonnet for summarization
4. Send as Telegram message

Replace the existing `generateDailyDigest` function body. Keep the same function signature and the Claude Sonnet call, but change the data source from Notion queries to:

```typescript
import { listRecent } from '../db/index.js';
```

Replace the per-database queries with:
```typescript
const recentThoughts = await listRecent(1, 100); // last 1 day, max 100
```

Group by thought_type in the formatting function, then pass to Claude Sonnet with the same system prompt (adjusted to expect flat thought data instead of category-specific entries).

The digest prompt in `src/digest/prompt.ts` will need updating to reflect the new data format — thoughts with type/topics/people instead of separate People/Projects/Ideas/Admin sections.

**Step 2: Update the daily digest prompt in src/digest/prompt.ts**

Replace the category-based sections with thought-type-based sections. The prompt should expect input like:

```
RECENT THOUGHTS (last 24 hours):

[task] Buy groceries — Topics: shopping. Action items: milk, eggs
[person_note] Sarah mentioned career change — People: Sarah. Topics: career
[idea] App for tracking habits — Topics: productivity, apps
...

PENDING ACTION ITEMS:
- Send API spec by Friday (from: Meeting with design team, 2 days ago)
- ...
```

**Step 3: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 4: Test manually**

Run: `/digest` command in Telegram
Expected: Digest generated from Postgres data

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(digest): rewrite daily digest to query Postgres"
```

---

### Task 12: Rewrite weekly digest and afternoon reminder

**Files:**
- Modify: `src/digest/weekly.ts` (replace Notion queries with Postgres)
- Modify: `src/digest/reminder.ts` (replace Notion queries with Postgres)
- Modify: `src/digest/overview.ts` (replace Notion queries with Postgres)
- Modify: `src/digest/prompt.ts` (update weekly and overview prompts)

**Step 1: Rewrite weekly.ts**

Same pattern as daily: use `listRecent(7, 200)` instead of per-database Notion queries. Include `getThoughtStats(7)` for the stats section (replaces inbox log stats). Update formatting to group by thought_type.

**Step 2: Rewrite reminder.ts**

Replace `queryDueAdmin()` with:
```typescript
import { pool } from '../db/index.js';

const { rows } = await pool.query(
  `SELECT * FROM thoughts
   WHERE thought_type = 'task'
   AND action_items != '{}'
   AND created_at > now() - interval '7 days'
   ORDER BY created_at DESC`
);
```

Format the action items from recent task-type thoughts and send as reminder. This is less precise than the old "due date" based approach but still surfaces tasks that need attention.

**Step 3: Rewrite overview.ts**

Replace per-category Notion queries with a single Postgres query that fetches recent thoughts grouped by type, then sends to Claude Sonnet for overview generation.

**Step 4: Update prompts in prompt.ts**

Update `WEEKLY_DIGEST_SYSTEM_PROMPT` and `OVERVIEW_SYSTEM_PROMPT` to expect the new flat thought format instead of category-specific Notion data.

**Step 5: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add -A && git commit -m "feat(digest): rewrite weekly digest, reminder, and overview on Postgres"
```

---

### Task 13: Update scheduler — drop interactive review

**Files:**
- Modify: `src/digest/scheduler.ts` (remove weekly review job)
- Delete: `src/digest/weekly-review.ts`
- Modify: `src/digest/index.ts` (remove weekly review export)
- Modify: `src/bot/index.ts` (remove review callback handler if separate)

**Step 1: Remove weekly review from scheduler**

In `src/digest/scheduler.ts`, remove the weekly review cron job (the 4th job, `30 {HOUR} * * {DAY}`). Remove the import of the review function and the `sendWithKeyboardFn` / `bot` parameters if they're only used for the review.

**Step 2: Delete weekly-review.ts**

```bash
rm src/digest/weekly-review.ts
```

**Step 3: Update digest barrel export**

Remove the weekly review export from `src/digest/index.ts`.

**Step 4: Remove review callback handler from bot**

In `src/bot/index.ts`, remove the review handler registration (line 28). Delete the review handler file if it exists as a separate file.

Also remove the `WEEKLY_REVIEW_ENABLED` config field from `src/config.ts` and the curate/review callback handlers.

**Step 5: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add -A && git commit -m "refactor(digest): remove interactive weekly review"
```

---

## Phase 6 — Cut Over

### Task 14: Remove Notion from message handler

**Files:**
- Modify: `src/bot/handlers/message.ts` (remove Notion writes, make Postgres the primary path)

**Step 1: Replace the message handler flow**

The message handler currently:
1. Rate limit → dedup → create inbox log → classify → intent check → bounce check → file to Notion → receipt

Replace with:
1. Rate limit → dedup (check Postgres source_id) → captureThought → receipt

The new `registerMessageHandler` body for text messages becomes:

```typescript
bot.on('message:text', async (ctx) => {
  const messageText = ctx.message.text;
  const telegramMessageId = ctx.message.message_id;
  const chatId = ctx.chat.id;

  if (!checkRateLimit(chatId)) {
    await ctx.reply('Zu viele Nachrichten. Bitte kurz warten.');
    return;
  }

  incrementPending();
  try {
    const thought = await captureThought({
      content: messageText,
      source: 'telegram',
      source_id: String(telegramMessageId),
      chat_id: chatId,
    });

    if (thought) {
      const receipt = [
        `<b>${thought.title ?? messageText.slice(0, 50)}</b>`,
        thought.thought_type ? `Typ: ${thought.thought_type}` : '',
        thought.topics?.length ? `Themen: ${thought.topics.join(', ')}` : '',
        thought.people?.length ? `Personen: ${thought.people.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      await ctx.reply(receipt, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('Fehler beim Speichern. Bitte erneut versuchen.');
    }

    markMessageProcessed();
  } finally {
    decrementPending();
  }
});
```

**Step 2: Remove all Notion-specific handler code**

Remove:
- The `fileAndReceipt` function
- The `fileAndReceiptDirect` function
- The bouncer flow (pendingBouncerMap, all `bounce:` callback handling)
- The relation flow (pendingRelationMap, all `rel:` / `rel-skip:` callback handling)
- The `suggestRelations` function
- The `buildReceipt` function
- The `writeFallback` function
- All Notion imports

**Step 3: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: Errors from other files still importing removed functions — fix in next tasks

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: replace Notion message handler with Postgres-only capture"
```

---

### Task 15: Remove Notion module and simplify bot

**Files:**
- Delete: `src/notion/` (entire directory)
- Delete: `src/classifier/` (entire directory — no longer needed with extractor)
- Modify: `src/bot/index.ts` (remove handlers that depended on Notion)
- Delete: `src/bot/handlers/fix.ts`
- Delete: `src/bot/handlers/intent.ts`
- Modify: `src/bot/handlers/commands.ts` (simplify /status, update /help)
- Modify: `src/types.ts` (remove Notion-specific types)
- Delete: `data/failed-messages.json` (if exists)
- Modify: `src/utils/errors.ts` (remove NotionError, ClassificationError, CalDavError)
- Modify: `package.json` (remove @notionhq/client)

**Step 1: Delete Notion and classifier modules**

```bash
rm -rf src/notion/ src/classifier/ src/bot/handlers/fix.ts src/bot/handlers/intent.ts
```

**Step 2: Simplify bot setup in src/bot/index.ts**

Remove handler registrations for:
- Fix handler (line 25)
- Intent callback handler (line 27)
- Review handler (line 28)

Keep:
- Chat ID allowlist middleware
- Command handlers
- Message handler

**Step 3: Update commands**

In `src/bot/handlers/commands.ts`:
- Remove `/status` command (it verified Notion databases)
- Update `/help` text to reflect the simplified system
- Keep `/digest`, `/weekly`, `/overview` (they now query Postgres)

**Step 4: Simplify types**

In `src/types.ts`, remove Notion-specific types (Category with 'unknown', Intent, InboxStatus, ClassificationResult, InboxEntry, ProcessingResult). Keep only what's needed for the new system or remove the file entirely if nothing remains.

**Step 5: Remove @notionhq/client dependency**

```bash
npm uninstall @notionhq/client
```

**Step 6: Clean up errors.ts**

Remove `NotionError`, `ClassificationError`, `CalDavError` from `src/utils/errors.ts`. Add `DatabaseError` if needed.

**Step 7: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors (fix any remaining broken imports)

**Step 8: Run tests**

Run: `npm test`
Expected: All remaining tests pass (CalDAV and Notion tests are gone, new tests pass)

**Step 9: Commit**

```bash
git add -A && git commit -m "refactor: remove Notion module, classifier, and legacy bot handlers"
```

---

### Task 16: Update config, env, CLAUDE.md

**Files:**
- Modify: `src/config.ts` (remove all Notion env vars, BOUNCE_THRESHOLD, WEEKLY_REVIEW_ENABLED)
- Modify: `.env.example` (remove Notion section, add Postgres/Voyage/MCP sections)
- Modify: `docker-compose.yml` (remove Notion-related comments if any)
- Modify: `CLAUDE.md` (update to reflect new architecture)

**Step 1: Clean up config.ts**

Remove from ConfigSchema:
- NOTION_API_KEY, NOTION_PARENT_PAGE_ID, NOTION_DB_PEOPLE, NOTION_DB_PROJECTS, NOTION_DB_IDEAS, NOTION_DB_ADMIN, NOTION_DB_INBOX_LOG
- BOUNCE_THRESHOLD
- WEEKLY_REVIEW_ENABLED

Keep:
- TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, WEBHOOK_DOMAIN
- ANTHROPIC_API_KEY
- PORT, NODE_ENV
- DIGEST_TIMEZONE, DAILY_DIGEST_HOUR, WEEKLY_DIGEST_DAY, AFTERNOON_REMINDER_HOUR
- DATABASE_URL
- VOYAGE_API_KEY
- MCP_ACCESS_KEY

**Step 2: Update .env.example**

Replace the Notion section with:
```bash
# Postgres (Open Brain)
DATABASE_URL=postgresql://openbrain:changeme@postgres:5432/openbrain
POSTGRES_PASSWORD=changeme

# Voyage AI (embeddings)
VOYAGE_API_KEY=your-voyage-api-key

# MCP Server
MCP_ACCESS_KEY=generate-a-random-secret-here
```

**Step 3: Update CLAUDE.md**

Rewrite to reflect the new architecture:
- Stack: TypeScript, Express, grammY, Anthropic SDK, Voyage AI, Postgres+pgvector, MCP SDK
- Architecture: Telegram capture → metadata extraction + embedding → Postgres → MCP server
- Remove all Notion references
- Remove CalDAV references
- Update database schema description
- Update commands list
- Update deployment notes
- Update gotchas

**Step 4: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add -A && git commit -m "docs: update config, env, and CLAUDE.md for Open Brain architecture"
```

---

## Phase 7 — Cleanup

### Task 17: Remove dead code, simplify state

**Files:**
- Modify: `src/utils/state.ts` (remove CalDAV invalidation if not already done, simplify)
- Modify: `src/index.ts` (clean up unused imports, simplify startup)
- Modify: `src/bot/handlers/message.ts` (ensure no dead code remains)
- Delete: `src/utils/retry.ts` (was used for Notion retries — check if still needed)
- Modify: `src/utils/telegram.ts` (keep — still used for splitting long messages)
- Modify: `scripts/setup-notion.ts` (delete — no longer needed)

**Step 1: Audit all source files for dead imports**

Run: `npx -p typescript tsc --noEmit` and fix any unused import warnings.

Check each file in `src/` for:
- Imports from deleted modules (notion, classifier, caldav)
- Unused functions
- Unused types

**Step 2: Delete setup-notion.ts**

```bash
rm scripts/setup-notion.ts
```

Remove the `setup` script from package.json.

**Step 3: Check if retry.ts is still used**

If `withRetry` is only used by the classifier or Notion module, delete it. If used by the extractor or embeddings, keep it.

**Step 4: Final type-check and test**

Run: `npx -p typescript tsc --noEmit && npm test`
Expected: Clean build, all tests pass

**Step 5: Commit**

```bash
git add -A && git commit -m "chore: remove dead code and unused dependencies"
```

---

### Task 18: Final review and verification

**Step 1: Build the project**

```bash
npm run build
```

Expected: Clean build, no errors

**Step 2: Docker build test**

```bash
docker compose build
```

Expected: Image builds successfully

**Step 3: Verify all env vars are documented**

Compare `src/config.ts` ConfigSchema fields with `.env.example`. Every required field should be documented.

**Step 4: Verify CLAUDE.md is accurate**

Read CLAUDE.md and verify every section reflects the current state of the codebase.

**Step 5: Run the full test suite**

```bash
npm test
```

Expected: All tests pass

**Step 6: Commit any final fixes**

```bash
git add -A && git commit -m "chore: final cleanup and verification"
```
