# Knowledge Learning Design

**Goal:** Let the user teach the bot personal facts (e.g. "Pavel ist ein Hund") so the classifier improves over time.

**Approach:** Simple `knowledge` table with facts injected into the extractor system prompt. In-memory cache, invalidated on writes.

---

## 1. Data Model

New table `knowledge`:

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

No embeddings, no vector — flat list of fact strings.

## 2. Bot Interaction

### `/correct <fact>` (Standalone)
- No reply needed — facts are context-free
- Stores the fact in `knowledge` table
- Responds: `💡 Gelernt: <fact>`
- Invalidates in-memory cache

### `/knowledge` (Standalone)
- Lists all stored facts with numeric keys
- Inline delete buttons (✗ N) per fact
- Same in-memory map pattern as `/open` (Telegram 64-byte callback_data limit)

## 3. Extractor Integration

- New `loadKnowledge()` query: `SELECT fact FROM knowledge ORDER BY created_at`
- In-memory cache (simple array), invalidated on `/correct` or delete
- Injected into system prompt before classification:

```
Du kennst folgenden persönlichen Kontext des Nutzers:
- Pavel ist ein Hund, keine Person
- Agila ist eine Tierversicherung

Berücksichtige dieses Wissen bei der Klassifizierung.
```

- Block omitted when 0 facts exist.

## 4. MCP Tool

- `add_knowledge({ fact })` — stores a fact, invalidates cache
- Returns confirmation text

## 5. /help Update

Add `/correct` and `/knowledge` to help text.
