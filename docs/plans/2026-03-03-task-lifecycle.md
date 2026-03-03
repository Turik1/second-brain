# Task Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add task completion, due dates, priorities, deletion, and actionable digests to Open Brain.

**Architecture:** Add `status`, `due_date`, `priority` columns to existing `thoughts` table. Extend metadata extractor to extract due dates and priority. Add reply-based `/done`, `/delete`, `/open` bot commands. Rebuild digests to surface open/overdue tasks. Add MCP tools for task management.

**Tech Stack:** TypeScript, grammY, pg, Zod, Anthropic SDK, MCP SDK

---

### Task 1: Database migration — add columns

**Files:**
- Modify: `src/db/migrate.ts`
- Modify: `src/db/queries.ts` (Thought interface)

**Step 1: Add migration SQL**

In `src/db/migrate.ts`, append to `MIGRATION_SQL` (after the existing CREATE INDEX statements):

```sql
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS priority VARCHAR(10);

CREATE INDEX IF NOT EXISTS thoughts_status_idx ON thoughts (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS thoughts_due_date_idx ON thoughts (due_date) WHERE due_date IS NOT NULL AND status = 'open';
```

**Step 2: Update Thought interface**

In `src/db/queries.ts`, add to the `Thought` interface:

```typescript
status: string;
due_date: Date | null;
priority: string | null;
```

Add to `ThoughtInsert`:

```typescript
due_date?: string;  // ISO date string
priority?: string;
```

**Step 3: Update insertThought**

Add `due_date` and `priority` to the INSERT column list and params:

```sql
INSERT INTO thoughts (content, embedding, title, thought_type, topics, people, action_items, source, source_id, chat_id, due_date, priority)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
```

Add params: `data.due_date ?? null`, `data.priority ?? null`.

**Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/migrate.ts src/db/queries.ts
git commit -m "feat(db): add status, due_date, priority columns to thoughts"
```

---

### Task 2: Extend metadata extractor

**Files:**
- Modify: `src/extractor/extract.ts`
- Modify: `src/extractor/__tests__/extract.test.ts`

**Step 1: Update Zod schema**

Add two new fields to `ThoughtMetadataSchema` in `src/extractor/extract.ts`:

```typescript
const ThoughtMetadataSchema = z.object({
  title: z.string().max(80),
  thought_type: z.enum([
    'task', 'person_note', 'idea', 'project', 'insight', 'decision', 'meeting',
  ]),
  topics: z.array(z.string()).max(5),
  people: z.array(z.string()),
  action_items: z.array(z.string()),
  due_date: z.string().nullable().optional(),
  priority: z.enum(['high', 'medium', 'low']).nullable().optional(),
});
```

**Step 2: Update system prompt**

Add to the `SYSTEM_PROMPT` in `src/extractor/extract.ts`:

```
- due_date: ISO-Datum (YYYY-MM-DD) wenn ein konkretes Datum oder relativer Zeitbezug im Text vorkommt ("morgen", "nächsten Freitag", "bis Ende März"). Heute ist ${new Date().toISOString().slice(0, 10)}. null wenn kein Datum erkennbar.
- priority: "high", "medium", oder "low" wenn Dringlichkeit erkennbar ("dringend", "wichtig", "asap" = high, "irgendwann", "wenn Zeit ist" = low). null wenn keine Dringlichkeit erkennbar.
```

Note: The system prompt must be changed from a static string to a function or template that injects the current date, since due_date extraction needs today's date for relative references. Simplest: make `SYSTEM_PROMPT` a getter function or compute it inside `extractMetadata`.

**Step 3: Update fallback defaults**

In the two fallback return statements, add:

```typescript
due_date: null,
priority: null,
```

**Step 4: Update test**

In `src/extractor/__tests__/extract.test.ts`, update the schema shape test to include `due_date` and `priority` in expected keys. Add a test that verifies the fallback includes the new fields.

**Step 5: Type-check and test**

Run: `npx tsc --noEmit && npm test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/extractor/extract.ts src/extractor/__tests__/extract.test.ts
git commit -m "feat(extractor): extract due_date and priority from messages"
```

---

### Task 3: Wire due_date and priority through capture pipeline

**Files:**
- Modify: `src/brain/store.ts`

**Step 1: Pass new fields to insertThought**

In `captureThought`, add `due_date` and `priority` from metadata to the `insertThought` call:

```typescript
const thought = await insertThought({
  content: input.content,
  embedding,
  title: metadata.title,
  thought_type: metadata.thought_type,
  topics: metadata.topics,
  people: metadata.people,
  action_items: metadata.action_items,
  due_date: metadata.due_date ?? undefined,
  priority: metadata.priority ?? undefined,
  source: input.source ?? 'telegram',
  source_id: input.source_id,
  chat_id: input.chat_id,
});
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/brain/store.ts
git commit -m "feat(brain): pass due_date and priority through capture pipeline"
```

---

### Task 4: Add query functions for task lifecycle

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/db/index.ts`

**Step 1: Add new query functions**

Append to `src/db/queries.ts`:

```typescript
export async function listOpenTasks(
  limit = 20,
  priority?: string,
): Promise<Thought[]> {
  const priorityFilter = priority ? 'AND priority = $3' : '';
  const params: unknown[] = [limit];
  if (priority) params.push(priority);

  const { rows } = await pool.query<Thought>(
    `SELECT * FROM thoughts
     WHERE status = 'open' AND thought_type IN ('task', 'project')
     ${priorityFilter}
     ORDER BY
       due_date ASC NULLS LAST,
       created_at DESC
     LIMIT $1`,
    params
  );
  return rows;
}

export async function listOverdue(): Promise<Thought[]> {
  const { rows } = await pool.query<Thought>(
    `SELECT * FROM thoughts
     WHERE status = 'open'
     AND due_date < CURRENT_DATE
     AND thought_type IN ('task', 'project')
     ORDER BY due_date ASC`
  );
  return rows;
}

export async function listDueToday(): Promise<Thought[]> {
  const { rows } = await pool.query<Thought>(
    `SELECT * FROM thoughts
     WHERE status = 'open'
     AND due_date = CURRENT_DATE
     AND thought_type IN ('task', 'project')
     ORDER BY created_at DESC`
  );
  return rows;
}

export async function updateThoughtStatus(
  id: string,
  status: 'open' | 'done' | 'cancelled',
): Promise<Thought | null> {
  const { rows } = await pool.query<Thought>(
    `UPDATE thoughts SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return rows[0] ?? null;
}

export async function findThoughtBySourceId(
  sourceId: string,
  chatId: number,
): Promise<Thought | null> {
  const { rows } = await pool.query<Thought>(
    `SELECT * FROM thoughts
     WHERE source_id = $1 AND chat_id = $2`,
    [sourceId, chatId]
  );
  return rows[0] ?? null;
}

export async function getOpenTaskStats(): Promise<{
  open: number;
  overdue: number;
  dueToday: number;
}> {
  const { rows } = await pool.query<{ open: string; overdue: string; due_today: string }>(
    `SELECT
       count(*) FILTER (WHERE status = 'open' AND thought_type IN ('task', 'project')) AS open,
       count(*) FILTER (WHERE status = 'open' AND due_date < CURRENT_DATE AND thought_type IN ('task', 'project')) AS overdue,
       count(*) FILTER (WHERE status = 'open' AND due_date = CURRENT_DATE AND thought_type IN ('task', 'project')) AS due_today
     FROM thoughts`
  );
  return {
    open: Number(rows[0].open),
    overdue: Number(rows[0].overdue),
    dueToday: Number(rows[0].due_today),
  };
}
```

**Step 2: Export from barrel**

In `src/db/index.ts`, add the new exports:

```typescript
export { insertThought, searchThoughts, listRecent, getThoughtStats, listTasksWithActions,
  listOpenTasks, listOverdue, listDueToday, updateThoughtStatus, findThoughtBySourceId, getOpenTaskStats
} from './queries.js';
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/db/queries.ts src/db/index.ts
git commit -m "feat(db): add query functions for task lifecycle"
```

---

### Task 5: Add /done command (reply-based)

**Files:**
- Modify: `src/bot/handlers/commands.ts`
- Modify: `src/bot/handlers/message.ts` (send receipt as reply)

**Step 1: Make receipt a reply to original message**

In `src/bot/handlers/message.ts`, change the `ctx.reply(receipt, ...)` call to include `reply_to_message_id`:

```typescript
await ctx.reply(receipt, {
  parse_mode: 'HTML',
  reply_parameters: { message_id: telegramMessageId },
});
```

This makes the bot receipt a reply to the user's original message, enabling the reply chain for `/done` and `/delete`.

**Step 2: Add /done command**

In `src/bot/handlers/commands.ts`, add after the existing imports:

```typescript
import { findThoughtBySourceId, updateThoughtStatus } from '../../db/index.js';
```

Add inside `registerCommandHandlers`, before the digest commands:

```typescript
bot.command('done', async (ctx) => {
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo) {
    await ctx.reply('Antworte auf eine Nachricht mit /done, um sie als erledigt zu markieren.');
    return;
  }

  // The receipt is a reply to the original message — get the original message ID
  const originalMessageId = replyTo.reply_to_message?.message_id ?? replyTo.message_id;
  const chatId = ctx.chat.id;

  const thought = await findThoughtBySourceId(String(originalMessageId), chatId);
  if (!thought) {
    await ctx.reply('Gedanke nicht gefunden.');
    return;
  }

  if (thought.status === 'done') {
    await ctx.reply('Bereits erledigt.');
    return;
  }

  const updated = await updateThoughtStatus(thought.id, 'done');
  if (updated) {
    await ctx.reply(`✓ Erledigt: ${updated.title ?? updated.content.slice(0, 50)}`);
    logger.info({ thoughtId: updated.id, title: updated.title }, 'Thought marked done');
  } else {
    await ctx.reply('Fehler beim Aktualisieren.');
  }
});
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/bot/handlers/commands.ts src/bot/handlers/message.ts
git commit -m "feat(bot): add /done command and reply-based receipts"
```

---

### Task 6: Add /delete command (reply-based)

**Files:**
- Modify: `src/bot/handlers/commands.ts`

**Step 1: Add /delete command**

In `registerCommandHandlers`, add right after the `/done` handler:

```typescript
bot.command('delete', async (ctx) => {
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo) {
    await ctx.reply('Antworte auf eine Nachricht mit /delete, um sie zu löschen.');
    return;
  }

  const originalMessageId = replyTo.reply_to_message?.message_id ?? replyTo.message_id;
  const chatId = ctx.chat.id;

  const thought = await findThoughtBySourceId(String(originalMessageId), chatId);
  if (!thought) {
    await ctx.reply('Gedanke nicht gefunden.');
    return;
  }

  const updated = await updateThoughtStatus(thought.id, 'cancelled');
  if (updated) {
    await ctx.reply(`Gelöscht: ${updated.title ?? updated.content.slice(0, 50)}`);
    logger.info({ thoughtId: updated.id, title: updated.title }, 'Thought cancelled');
  } else {
    await ctx.reply('Fehler beim Löschen.');
  }
});
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/handlers/commands.ts
git commit -m "feat(bot): add /delete command for soft-deleting thoughts"
```

---

### Task 7: Add /open command

**Files:**
- Modify: `src/bot/handlers/commands.ts`

**Step 1: Add /open command**

In `registerCommandHandlers`, add:

```typescript
import { findThoughtBySourceId, updateThoughtStatus, listOpenTasks } from '../../db/index.js';
```

(Update the existing import to include `listOpenTasks`.)

Then add the command:

```typescript
bot.command('open', async (ctx) => {
  const tasks = await listOpenTasks(20);

  if (tasks.length === 0) {
    await ctx.reply('Keine offenen Aufgaben. Alles erledigt!');
    return;
  }

  const lines = [`<b>Offene Aufgaben (${tasks.length})</b>\n`];
  for (const t of tasks) {
    const title = t.title ?? t.content.slice(0, 60);
    const parts: string[] = [`• ${title}`];
    if (t.due_date) {
      const dueStr = new Date(t.due_date).toISOString().slice(0, 10);
      const isOverdue = new Date(t.due_date) < new Date(new Date().toISOString().slice(0, 10));
      parts[0] += isOverdue ? ` ⚠️ ${dueStr}` : ` 📅 ${dueStr}`;
    }
    if (t.priority === 'high') parts[0] += ' 🔴';
    lines.push(parts[0]);
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});
```

**Step 2: Update /help command**

Add the new commands to the help text:

```typescript
'/open — Offene Aufgaben anzeigen\n' +
'/done — (Reply) Aufgabe als erledigt markieren\n' +
'/delete — (Reply) Gedanke löschen\n' +
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/bot/handlers/commands.ts
git commit -m "feat(bot): add /open command and update help text"
```

---

### Task 8: Rebuild daily digest with open tasks

**Files:**
- Modify: `src/digest/daily.ts`
- Modify: `src/digest/prompt.ts`
- Modify: `src/digest/format.ts`

**Step 1: Add open tasks section to daily digest input**

In `src/digest/daily.ts`, import and fetch open/overdue tasks:

```typescript
import { listRecent, listOverdue, listDueToday } from '../db/index.js';
```

After fetching `recentThoughts`, add:

```typescript
const [overdueTasks, dueTodayTasks] = await Promise.all([
  listOverdue(),
  listDueToday(),
]);
```

Prepend an action section to `formattedInput`:

```typescript
let actionSection = '';
if (overdueTasks.length > 0 || dueTodayTasks.length > 0) {
  actionSection = formatOpenTasksSection(overdueTasks, dueTodayTasks) + '\n\n';
}
let formattedInput = actionSection + formatThoughtsForDigest(recentThoughts);
```

**Step 2: Add formatOpenTasksSection to format.ts**

In `src/digest/format.ts`:

```typescript
export function formatOpenTasksSection(overdue: Thought[], dueToday: Thought[]): string {
  const lines: string[] = ['ACTIONABLE:'];
  if (overdue.length > 0) {
    lines.push(`Overdue (${overdue.length}):`);
    for (const t of overdue) {
      const due = t.due_date ? new Date(t.due_date).toISOString().slice(0, 10) : '';
      lines.push(`- ${t.title ?? t.content.slice(0, 80)} (fällig: ${due})`);
    }
  }
  if (dueToday.length > 0) {
    lines.push(`Due today (${dueToday.length}):`);
    for (const t of dueToday) {
      lines.push(`- ${t.title ?? t.content.slice(0, 80)}`);
    }
  }
  return lines.join('\n');
}
```

**Step 3: Update daily digest prompt**

In `src/digest/prompt.ts`, update `DAILY_DIGEST_SYSTEM_PROMPT` — add before the existing section list:

```
If an ACTIONABLE section is present, prioritize it. Start the digest with overdue and due-today tasks. These are the most important items for the user's morning briefing.
```

**Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/digest/daily.ts src/digest/format.ts src/digest/prompt.ts
git commit -m "feat(digest): daily digest now surfaces overdue and due-today tasks"
```

---

### Task 9: Rebuild afternoon reminder with open task stats

**Files:**
- Modify: `src/digest/reminder.ts`

**Step 1: Rewrite reminder to use open task stats**

Replace the current `generateAfternoonReminder` implementation:

```typescript
import { logger } from '../utils/logger.js';
import { getOpenTaskStats, listOpenTasks } from '../db/index.js';

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
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/digest/reminder.ts
git commit -m "feat(digest): afternoon reminder shows open task counts"
```

---

### Task 10: Add stale tasks section to weekly digest

**Files:**
- Modify: `src/digest/weekly.ts`
- Modify: `src/digest/prompt.ts`
- Modify: `src/digest/format.ts`

**Step 1: Fetch stale open tasks**

In `src/digest/weekly.ts`, add import and query:

```typescript
import { listRecent, getThoughtStats, listOpenTasks } from '../db/index.js';
import { formatThoughtsForDigest, formatStatsSection, formatOpenTasksSection } from './format.js';
```

After the existing `Promise.all`, fetch open tasks:

```typescript
const openTasks = await listOpenTasks(50);
```

Add open tasks section to input:

```typescript
const staleTasks = openTasks.filter(t => {
  const age = Date.now() - t.created_at.getTime();
  return age > 7 * 24 * 60 * 60 * 1000; // older than 7 days
});
let openSection = '';
if (staleTasks.length > 0) {
  openSection = `\nSTALE OPEN TASKS (${staleTasks.length}, older than 7 days):\n` +
    staleTasks.map(t => `- ${t.title ?? t.content.slice(0, 80)} (${Math.floor((Date.now() - t.created_at.getTime()) / 86400000)} days old)`).join('\n') + '\n';
}

let formattedInput = `${statsSection}${openSection}\n\nTHOUGHTS:\n${thoughtsSection}`;
```

**Step 2: Update weekly digest prompt**

In `src/digest/prompt.ts`, add to `WEEKLY_DIGEST_SYSTEM_PROMPT` after the existing sections:

```
7. <b>Offene Altlasten</b> - If STALE OPEN TASKS are present, list them and suggest: erledigen, verschieben, oder streichen?
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/digest/weekly.ts src/digest/prompt.ts src/digest/format.ts
git commit -m "feat(digest): weekly digest surfaces stale open tasks"
```

---

### Task 11: Add MCP tools for task management

**Files:**
- Modify: `src/mcp/server.ts`

**Step 1: Import new query functions**

Update imports:

```typescript
import { searchThoughts, listRecent, getThoughtStats, listOpenTasks, updateThoughtStatus } from '../db/index.js';
```

**Step 2: Add list_open_tasks tool**

```typescript
server.tool(
  'list_open_tasks',
  'List all open tasks and projects, sorted by due date. Use this to see what needs attention.',
  {
    limit: z.number().int().min(1).max(50).default(20).describe('Max results'),
    priority: z.string().optional().describe('Filter by priority: high, medium, low'),
  },
  async ({ limit, priority }) => {
    const tasks = await listOpenTasks(limit, priority);

    const formatted = tasks.map((t) => {
      const parts = [`**${t.title ?? 'Untitled'}** (${t.thought_type ?? 'task'})`];
      if (t.due_date) parts.push(`Due: ${new Date(t.due_date).toISOString().slice(0, 10)}`);
      if (t.priority) parts.push(`Priority: ${t.priority}`);
      if (t.action_items?.length) parts.push(`Action items: ${t.action_items.join('; ')}`);
      parts.push(`Captured: ${t.created_at.toISOString().slice(0, 10)}`);
      parts.push(`ID: ${t.id}`);
      return parts.join('\n');
    });

    return {
      content: [{
        type: 'text' as const,
        text: tasks.length
          ? `${tasks.length} open tasks:\n\n` + formatted.join('\n\n---\n\n')
          : 'No open tasks. Everything is done!',
      }],
    };
  }
);
```

**Step 3: Add complete_thought tool**

```typescript
server.tool(
  'complete_thought',
  'Mark a thought/task as done by its ID.',
  {
    id: z.string().uuid().describe('The thought ID to mark as done'),
  },
  async ({ id }) => {
    const updated = await updateThoughtStatus(id, 'done');
    if (!updated) {
      return { content: [{ type: 'text' as const, text: `Thought ${id} not found.` }] };
    }
    return {
      content: [{
        type: 'text' as const,
        text: `Marked as done: ${updated.title ?? updated.content.slice(0, 50)}`,
      }],
    };
  }
);
```

**Step 4: Add delete_thought tool**

```typescript
server.tool(
  'delete_thought',
  'Soft-delete a thought by its ID (sets status to cancelled).',
  {
    id: z.string().uuid().describe('The thought ID to delete'),
  },
  async ({ id }) => {
    const updated = await updateThoughtStatus(id, 'cancelled');
    if (!updated) {
      return { content: [{ type: 'text' as const, text: `Thought ${id} not found.` }] };
    }
    return {
      content: [{
        type: 'text' as const,
        text: `Deleted: ${updated.title ?? updated.content.slice(0, 50)}`,
      }],
    };
  }
);
```

**Step 5: Add status filter to existing search_thoughts and list_recent tools**

Add `status: z.string().optional().describe('Filter by status: open, done, cancelled')` to both tools' parameter schemas.

Update `searchThoughts` and `listRecent` calls to pass the status filter (requires updating the query functions — see next step).

**Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 7: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(mcp): add list_open_tasks, complete_thought, delete_thought tools"
```

---

### Task 12: Add status filter to existing queries

**Files:**
- Modify: `src/db/queries.ts`

**Step 1: Add status filter to searchThoughts**

Update `searchThoughts` signature:

```typescript
export async function searchThoughts(
  queryEmbedding: number[],
  limit = 10,
  thoughtType?: string,
  status?: string,
): Promise<(Thought & { similarity: number })[]> {
```

Add status filter logic alongside existing type filter:

```typescript
const statusFilter = status ? `AND status = $${params.length + 1}` : '';
if (status) params.push(status);
```

**Step 2: Add status filter to listRecent**

Same pattern — add optional `status` parameter, add SQL filter.

**Step 3: Update db/index.ts exports if needed**

Signatures changed but exports stay the same — just verify.

**Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/queries.ts
git commit -m "feat(db): add status filter to searchThoughts and listRecent"
```

---

### Task 13: Update message receipt to show due date and priority

**Files:**
- Modify: `src/bot/handlers/message.ts`

**Step 1: Add due_date and priority to receipt**

In the receipt builder, add:

```typescript
const receipt = [
  `<b>${escapeHtml(thought.title ?? messageText.slice(0, 50))}</b>`,
  thought.thought_type ? `Typ: ${thought.thought_type}` : '',
  thought.due_date ? `Fällig: ${new Date(thought.due_date).toISOString().slice(0, 10)}` : '',
  thought.priority ? `Priorität: ${thought.priority}` : '',
  thought.topics?.length ? `Themen: ${thought.topics.join(', ')}` : '',
  thought.people?.length ? `Personen: ${thought.people.join(', ')}` : '',
].filter(Boolean).join('\n');
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/handlers/message.ts
git commit -m "feat(bot): show due date and priority in capture receipt"
```

---

### Task 14: Update CLAUDE.md and .env.example

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update data model section**

Add to the Data Model section:

```
- status (open/done/cancelled), due_date, priority (high/medium/low)
```

**Step 2: Update MCP tools section**

Add:

```
- `list_open_tasks` - open tasks sorted by due date
- `complete_thought` - mark task done by ID
- `delete_thought` - soft-delete by ID
```

**Step 3: Update bot commands in help reference**

Add note about `/open`, `/done`, `/delete` commands.

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with task lifecycle features"
```

---

### Task 15: Final verification

**Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 2: Run tests**

Run: `npm test`
Expected: All pass

**Step 3: Build**

Run: `npm run build`
Expected: PASS

**Step 4: Verify docker compose config**

Run: `docker compose config` (with .env present or `--env-file /dev/null`)

**Step 5: Commit if needed**

```bash
git commit -m "chore: final verification for task lifecycle"
```
