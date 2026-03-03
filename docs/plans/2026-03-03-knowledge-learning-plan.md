# Knowledge Learning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the user teach the bot personal facts via `/correct` so the classifier improves over time.

**Architecture:** New `knowledge` table stores facts as plain text. Facts are loaded into an in-memory cache and injected into the extractor system prompt before each classification. Bot commands `/correct` and `/knowledge` manage the facts. MCP tool `add_knowledge` for programmatic access.

**Tech Stack:** TypeScript, PostgreSQL, grammY, MCP SDK

---

### Task 1: Database Migration — knowledge table

**Files:**
- Modify: `src/db/migrate.ts:4-37` (append to MIGRATION_SQL)

**Step 1: Add knowledge table to migration SQL**

Append to `MIGRATION_SQL` string, before the closing backtick on line 37:

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**Step 2: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/db/migrate.ts
git commit -m "feat(knowledge): add knowledge table migration"
```

---

### Task 2: Query layer — knowledge CRUD

**Files:**
- Modify: `src/db/queries.ts` (append new functions at bottom)
- Modify: `src/db/index.ts` (add exports)

**Step 1: Add query functions to `src/db/queries.ts`**

Append at the end of the file:

```typescript
export interface KnowledgeFact {
  id: string;
  fact: string;
  created_at: Date;
}

export async function insertKnowledge(fact: string): Promise<KnowledgeFact> {
  const { rows } = await pool.query<KnowledgeFact>(
    `INSERT INTO knowledge (fact) VALUES ($1) RETURNING *`,
    [fact]
  );
  return rows[0];
}

export async function listKnowledge(): Promise<KnowledgeFact[]> {
  const { rows } = await pool.query<KnowledgeFact>(
    `SELECT * FROM knowledge ORDER BY created_at`
  );
  return rows;
}

export async function deleteKnowledge(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM knowledge WHERE id = $1`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}
```

**Step 2: Export from `src/db/index.ts`**

Add `insertKnowledge`, `listKnowledge`, `deleteKnowledge` to the exports from `./queries.js`. Add `KnowledgeFact` to the type exports.

```typescript
export { insertThought, searchThoughts, listRecent, getThoughtStats, listTasksWithActions,
  listOpenTasks, listOverdue, listDueToday, updateThoughtStatus, updateThoughtDueDate, findThoughtBySourceId, getOpenTaskStats,
  insertKnowledge, listKnowledge, deleteKnowledge
} from './queries.js';
export type { Thought, ThoughtInsert, KnowledgeFact } from './queries.js';
```

**Step 3: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/db/queries.ts src/db/index.ts
git commit -m "feat(knowledge): add knowledge CRUD queries"
```

---

### Task 3: Knowledge cache + extractor integration

**Files:**
- Modify: `src/extractor/extract.ts:22-46` (inject knowledge into system prompt)

**Step 1: Add cache and loader to `src/extractor/extract.ts`**

After the existing imports (line 4), add:

```typescript
import { listKnowledge } from '../db/index.js';

let knowledgeCache: string[] | null = null;

export function invalidateKnowledgeCache(): void {
  knowledgeCache = null;
}

async function getKnowledgeFacts(): Promise<string[]> {
  if (knowledgeCache) return knowledgeCache;
  const facts = await listKnowledge();
  knowledgeCache = facts.map(f => f.fact);
  return knowledgeCache;
}
```

**Step 2: Inject knowledge into system prompt**

In `extractMetadata()`, after line 23 (`const today = ...`) and before the `const systemPrompt = ...` on line 24, load knowledge and build the injection block:

```typescript
  const facts = await getKnowledgeFacts();
  const knowledgeBlock = facts.length > 0
    ? `\n\nDu kennst folgenden persönlichen Kontext des Nutzers:\n${facts.map(f => `- ${f}`).join('\n')}\n\nBerücksichtige dieses Wissen bei der Klassifizierung.`
    : '';
```

Then append `knowledgeBlock` to the end of the system prompt string. Change the closing of the systemPrompt (line 40, ending with `null wenn keine Dringlichkeit erkennbar.`) to:

```typescript
- priority: "high", "medium", oder "low" wenn Dringlichkeit erkennbar ("dringend", "wichtig", "asap" = high, "irgendwann", "wenn Zeit ist" = low). null wenn keine Dringlichkeit erkennbar.${knowledgeBlock}`;
```

**Step 3: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/extractor/extract.ts
git commit -m "feat(knowledge): inject knowledge facts into extractor prompt"
```

---

### Task 4: Bot commands — /correct and /knowledge

**Files:**
- Modify: `src/bot/handlers/commands.ts:1-4` (add imports)
- Modify: `src/bot/handlers/commands.ts` (add commands before digest commands)
- Modify: `src/bot/handlers/commands.ts` (update /help text)

**Step 1: Update imports in `commands.ts`**

Add `insertKnowledge`, `listKnowledge`, `deleteKnowledge` to the db import on line 3:

```typescript
import { findThoughtBySourceId, updateThoughtStatus, updateThoughtDueDate, listOpenTasks, insertKnowledge, listKnowledge, deleteKnowledge } from '../../db/index.js';
```

Add the knowledge cache invalidation import after line 4:

```typescript
import { invalidateKnowledgeCache } from '../../extractor/extract.js';
```

**Step 2: Add in-memory map for knowledge delete buttons**

After `let openTaskCounter = 0;` (line 8), add:

```typescript
const knowledgeMap = new Map<number, string>(); // numeric key -> knowledge UUID
let knowledgeCounter = 0;
```

**Step 3: Add /correct command**

Add before the `bot.command('digest', ...)` block:

```typescript
  bot.command('correct', async (ctx) => {
    const fact = ctx.message?.text?.replace(/^\/correct\s*/i, '').trim();
    if (!fact) {
      await ctx.reply('Schreib: /correct <Fakt>\n\nBeispiel: /correct Pavel ist unser Hund, keine Person');
      return;
    }

    await insertKnowledge(fact);
    invalidateKnowledgeCache();
    await ctx.reply(`💡 Gelernt: ${fact}`);
    logger.info({ fact }, 'Knowledge fact added');
  });
```

**Step 4: Add /knowledge command**

Add after the `/correct` command:

```typescript
  bot.command('knowledge', async (ctx) => {
    const facts = await listKnowledge();

    if (facts.length === 0) {
      await ctx.reply('Noch kein Wissen gespeichert. Nutze /correct um etwas beizubringen.');
      return;
    }

    knowledgeMap.clear();
    knowledgeCounter = 0;

    const lines = [`<b>Wissen (${facts.length})</b>\n`];
    const keyboard = new InlineKeyboard();

    for (const f of facts) {
      const key = ++knowledgeCounter;
      knowledgeMap.set(key, f.id);
      lines.push(`${key}. ${f.fact}`);
      keyboard.text(`✗ ${key}`, `delknow:${key}`).row();
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });
```

**Step 5: Add callback handler for knowledge deletion**

Add after the `/knowledge` command:

```typescript
  bot.callbackQuery(/^delknow:(\d+)$/, async (ctx) => {
    const key = parseInt(ctx.match![1]);
    const knowledgeId = knowledgeMap.get(key);

    if (!knowledgeId) {
      await ctx.answerCallbackQuery({ text: 'Eintrag nicht mehr verfügbar.' });
      return;
    }

    const deleted = await deleteKnowledge(knowledgeId);
    knowledgeMap.delete(key);

    if (deleted) {
      invalidateKnowledgeCache();
      await ctx.answerCallbackQuery({ text: 'Wissen gelöscht.' });
      logger.info({ knowledgeId }, 'Knowledge fact deleted');
    } else {
      await ctx.answerCallbackQuery({ text: 'Fehler beim Löschen.' });
    }
  });
```

**Step 6: Update /help text**

In the `/help` command, add these two lines after the `/postpone` line:

```
'/correct — Wissen beibringen (z.B. /correct Pavel ist ein Hund)\n' +
'/knowledge — Gespeichertes Wissen anzeigen/löschen\n' +
```

**Step 7: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: no errors

**Step 8: Commit**

```bash
git add src/bot/handlers/commands.ts
git commit -m "feat(knowledge): add /correct and /knowledge bot commands"
```

---

### Task 5: MCP tool — add_knowledge

**Files:**
- Modify: `src/mcp/server.ts:3` (add imports)
- Modify: `src/mcp/server.ts` (add tool before `return server`)

**Step 1: Update MCP server imports**

On line 3, add `insertKnowledge` to the db import:

```typescript
import { searchThoughts, listRecent, getThoughtStats, listOpenTasks, updateThoughtStatus, updateThoughtDueDate, insertKnowledge } from '../db/index.js';
```

Add after line 5:

```typescript
import { invalidateKnowledgeCache } from '../extractor/extract.js';
```

**Step 2: Add the tool**

Before `return server;`, add:

```typescript
  server.tool(
    'add_knowledge',
    'Teach the bot a personal fact that will be used in future classifications. E.g. "Pavel ist ein Hund, keine Person".',
    {
      fact: z.string().min(3).max(500).describe('The fact to remember'),
    },
    async ({ fact }) => {
      await insertKnowledge(fact);
      invalidateKnowledgeCache();
      return {
        content: [{ type: 'text' as const, text: `Learned: ${fact}` }],
      };
    }
  );
```

**Step 3: Type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(knowledge): add MCP add_knowledge tool"
```

---

### Task 6: Final verification + deploy

**Step 1: Full type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: no errors

**Step 2: Build**

Run: `npm run build`
Expected: compiles without errors

**Step 3: Push and deploy**

```bash
git push
```

Wait for GitHub Actions to deploy successfully.

**Step 4: Test in Telegram**

1. Send `/correct Pavel ist unser Hund, keine Person` → expect "💡 Gelernt: Pavel ist unser Hund, keine Person"
2. Send `/knowledge` → expect list with "1. Pavel ist unser Hund, keine Person" and delete button
3. Send a message mentioning Pavel → verify it's NOT classified as a person
4. Delete the test fact via ✗ button → expect "Wissen gelöscht."
