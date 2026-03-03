# Task Lifecycle Design

**Goal:** Turn Open Brain from a capture-only tool into a trusted system with task completion, due dates, priorities, and actionable digests.

**Approach:** Add columns to existing `thoughts` table (Ansatz A — flat, simple, YAGNI).

---

## 1. Data Model

Three new columns on `thoughts`:

```sql
status    VARCHAR(20) DEFAULT 'open'  -- open | done | cancelled
due_date  DATE                         -- NULL if no date
priority  VARCHAR(10)                  -- high | medium | low | NULL
```

- `status` is relevant for `thought_type IN ('task', 'project')`. Other types keep default `open` and it's ignored.
- `due_date` and `priority` are extracted automatically by Haiku when present in text.
- Migration: `ALTER TABLE ADD COLUMN` (idempotent via `IF NOT EXISTS` or check).

## 2. Bot Interaction

### `/done` (Reply-based)
- Reply to a bot receipt message with `/done`
- Bot finds original thought via reply chain: `ctx.message.reply_to_message.message_id` → lookup by `source_id`
- Sets `status = 'done'`, replies "Erledigt: [Titel]"
- Prerequisite: capture receipt must be sent as reply to original message (`reply_to_message_id`)

### `/open` (Standalone)
- Lists all thoughts with `status = 'open' AND thought_type IN ('task', 'project')`
- Sorted by: overdue first, then by due_date ASC, then by created_at DESC
- Max 20 items
- Format: each item shows title, due date (if any), priority (if any), age

### `/delete` (Reply-based)
- Same reply mechanic as `/done`
- Sets `status = 'cancelled'` (soft delete)
- Replies "Gelöscht: [Titel]"

## 3. Metadata Extraction

Extend Zod schema in `src/extractor/extract.ts`:

- `due_date`: optional ISO date string. Extract from natural language ("morgen", "nächsten Freitag", "bis Ende März"). Haiku resolves relative dates against current date.
- `priority`: optional enum `high | medium | low`. Extract from urgency signals ("dringend", "wichtig", "irgendwann mal").

System prompt addition: "Extract due_date only when text contains a concrete date or relative time reference. Extract priority only when text signals urgency. Leave both null otherwise."

## 4. Digest Redesign

### Daily Digest (6 Uhr)
1. **Fällig heute / überfällig** — `WHERE status = 'open' AND due_date <= today`
2. **Gestern erfasst** — existing behavior, but with status badge

### Nachmittags-Reminder (14 Uhr)
- "Du hast X offene Tasks, davon Y fällig heute."
- Only send if there are open tasks.

### Weekly Digest (Sonntag)
- New section: "Diese Tasks sind seit 7+ Tagen offen" — surfaces stale/forgotten tasks.

## 5. MCP Tools

New tools:
- `list_open_tasks` — open tasks/projects, optional filter by priority or due date range
- `complete_thought` — set status to `done` by ID
- `delete_thought` — set status to `cancelled` by ID

Existing tools:
- `search_thoughts` and `list_recent` gain optional `status` filter parameter

## 6. Query Layer

New functions in `src/db/queries.ts`:
- `listOpenTasks(limit?, priority?)` — open tasks sorted by due date
- `listOverdue()` — open tasks with `due_date < today`
- `updateThoughtStatus(id, status)` — set status by ID
- `findThoughtBySourceId(sourceId, chatId)` — lookup for reply-based commands
- `getOpenTaskStats()` — count open, overdue, due today (for reminder)
