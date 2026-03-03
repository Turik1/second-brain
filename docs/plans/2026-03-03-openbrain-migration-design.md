# Open Brain Migration Design

## Summary

Migrate from the current Notion-backed Second Brain (structured 4-category databases with classification, intents, relations, CalDAV) to a flat Postgres+pgvector "Open Brain" (single `thoughts` table with vector embeddings and LLM-extracted metadata). Add an MCP server so any AI client (Claude Desktop, Claude Code, ChatGPT, Cursor) can search and write to the brain.

## Decisions

- **Data model**: Flat `thoughts` table — no separate category tables, no explicit relations, no status management
- **Infrastructure**: Self-hosted Postgres+pgvector on existing Hetzner VPS (Docker Compose)
- **Capture**: Telegram (existing habit) + MCP write tool (any AI client)
- **Embeddings**: Anthropic Voyager (1024 dimensions, uses existing API key)
- **MCP transport**: HTTP via Express + Caddy reverse proxy
- **Digests**: Rebuilt on flat table queries + Claude Sonnet summarization
- **Migration approach**: Parallel run — dual-write to Notion + Postgres, validate, then cut over
- **Dropped features**: CalDAV, bouncer flow, intent detection (done/update), relation suggestions, fix command, interactive weekly review, Notion dependency

## Data Model

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE thoughts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  embedding     vector(1024),

  -- LLM-extracted metadata
  title         TEXT,
  thought_type  TEXT,       -- task, person_note, idea, project, insight, decision, meeting
  topics        TEXT[],
  people        TEXT[],
  action_items  TEXT[],

  -- source tracking
  source        TEXT NOT NULL DEFAULT 'telegram',
  source_id     TEXT,
  chat_id       BIGINT,

  -- timestamps
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON thoughts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE UNIQUE INDEX ON thoughts (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX ON thoughts (created_at DESC);
CREATE INDEX ON thoughts (thought_type);
```

## Capture Flow

```
Telegram message (or MCP capture_thought call)
    |
    v
Dedup check (source + source_id)
    |
    v
Parallel:
  +-- Generate embedding (Voyager API, 1024 dims)
  +-- Extract metadata (Claude Haiku -> title, type, topics, people, action_items)
    |
    v
INSERT into thoughts
    |
    v
Send receipt (Telegram) or return confirmation (MCP)
```

Metadata extraction prompt (replaces full classification):
```
Extract from this message:
- title: short summary (max 80 chars)
- thought_type: one of task/person_note/idea/project/insight/decision/meeting
- topics: up to 5 topic tags
- people: names mentioned
- action_items: any tasks or follow-ups mentioned
```

## MCP Server

Four tools, mounted at `/mcp` on the Express app:

| Tool | Input | Output |
|------|-------|--------|
| `search_thoughts` | query, limit?, thought_type? | Semantic nearest-neighbors with similarity scores |
| `list_recent` | days?, thought_type?, limit? | Recent thoughts by created_at DESC |
| `thought_stats` | days? | Counts by type, top topics, top people, frequency |
| `capture_thought` | content, source? | Runs embed+extract pipeline, returns confirmation |

Auth: Bearer token via `Authorization` header or `x-brain-key` header. Caddy proxies HTTPS to Express.

Client config (Claude Desktop):
```json
{
  "mcpServers": {
    "open-brain": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-domain/mcp",
        "--header",
        "Authorization: Bearer ${BRAIN_KEY}"
      ],
      "env": { "BRAIN_KEY": "your-secret-key" }
    }
  }
}
```

## Digests (Rebuilt)

**Daily digest**: Query last 24h of thoughts, group by type in prompt, Claude Sonnet summarizes. Sent to Telegram in German.

**Weekly digest**: Query last 7 days, Claude Sonnet generates week summary with themes, unresolved action items, patterns, stats.

**Afternoon reminder**: Query recent thoughts where thought_type='task' and action_items is not null. Send reminder if any exist.

**Weekly review**: No interactive buttons. The weekly digest itself becomes analytical — pattern detection, connection mapping, gap analysis. Matches the Open Brain article's "Weekly Review" philosophy.

## Migration Phases

### Phase 1 — Infrastructure + Drop CalDAV
- Remove CalDAV module (`src/caldav/`), unmount from Express, remove env vars
- Add `postgres:16` + pgvector to `docker-compose.yml` with persistent volume
- Create `src/db/` module: connection pool (pg), migrations, query helpers
- Create `src/embeddings/` module: Voyager API wrapper
- Create metadata extraction utility (Claude Haiku call with Zod output schema)
- Add new env vars: `DATABASE_URL`, `MCP_ACCESS_KEY`

### Phase 2 — Dual Write
- Wire message handler to call the new embed+extract+insert pipeline AFTER the existing Notion write
- Postgres write is fire-and-forget during this phase (errors logged, don't block Telegram receipt)
- Validate: every Telegram capture produces a matching thought row with embedding
- Run for ~1 week to verify stability

### Phase 3 — MCP Server
- Add `/mcp` route to Express with Streamable HTTP transport
- Implement 4 tools: search_thoughts, list_recent, thought_stats, capture_thought
- Add bearer token auth middleware
- Update Caddy config to proxy `/mcp`
- Test with Claude Desktop (via mcp-remote) and Claude Code

### Phase 4 — Notion Data Migration
- Script to export all Notion entries via API (People, Projects, Ideas, Admin)
- Convert each entry to a thought: combine title + description/context + metadata into content
- Generate embeddings, extract metadata, insert into Postgres
- Source='migration', source_id=notion page ID (for dedup if re-run)
- Verify: count rows, spot-check semantic search finds migrated data

### Phase 5 — Rebuild Digests
- Rewrite daily digest to query Postgres instead of Notion
- Rewrite weekly digest similarly
- Rewrite afternoon reminder to query thought_type='task'
- Drop interactive weekly review (replace with analytical summary)
- Test for ~1 week (optionally compare with old Notion-based digests)

### Phase 6 — Cut Over
- Remove Notion writes from message handler
- Remove `src/notion/` module and `@notionhq/client` dependency
- Remove Notion env vars from config
- Remove bouncer, intent, relation, and fix handler code
- Update bot commands: simplify `/help`, remove `/status` Notion checks
- Update CLAUDE.md
- Deploy

### Phase 7 — Cleanup
- Remove dead code: bouncer maps, intent maps, relation maps, fix handler
- Remove failed-messages.json fallback (Postgres transactions are atomic)
- Simplify message handler to the new single-path flow
- Update docker-compose.yml: remove any Notion-related config
- Final code review
