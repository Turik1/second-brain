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

export async function insertThought(data: ThoughtInsert): Promise<Thought | null> {
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
  return rows[0] ?? null;
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

interface CountRow { count: string }
interface TypeCountRow { thought_type: string; count: string }
interface TopicCountRow { topic: string; count: string }
interface PersonCountRow { person: string; count: string }

export async function getThoughtStats(days = 30): Promise<{
  total: number;
  byType: Record<string, number>;
  topTopics: { topic: string; count: number }[];
  topPeople: { person: string; count: number }[];
}> {
  const totalResult = await pool.query<CountRow>(
    `SELECT count(*) FROM thoughts WHERE created_at > now() - make_interval(days => $1)`,
    [days]
  );

  const typeResult = await pool.query<TypeCountRow>(
    `SELECT thought_type, count(*) FROM thoughts
     WHERE created_at > now() - make_interval(days => $1) AND thought_type IS NOT NULL
     GROUP BY thought_type ORDER BY count DESC`,
    [days]
  );

  const topicsResult = await pool.query<TopicCountRow>(
    `SELECT topic, count(*) FROM thoughts,
     unnest(topics) AS topic
     WHERE created_at > now() - make_interval(days => $1)
     GROUP BY topic ORDER BY count DESC LIMIT 10`,
    [days]
  );

  const peopleResult = await pool.query<PersonCountRow>(
    `SELECT person, count(*) FROM thoughts,
     unnest(people) AS person
     WHERE created_at > now() - make_interval(days => $1)
     GROUP BY person ORDER BY count DESC LIMIT 10`,
    [days]
  );

  return {
    total: Number(totalResult.rows[0].count),
    byType: Object.fromEntries(typeResult.rows.map((r) => [r.thought_type, Number(r.count)])),
    topTopics: topicsResult.rows.map((r) => ({ topic: r.topic, count: Number(r.count) })),
    topPeople: peopleResult.rows.map((r) => ({ person: r.person, count: Number(r.count) })),
  };
}

export async function listTasksWithActions(days = 7): Promise<Thought[]> {
  const { rows } = await pool.query<Thought>(
    `SELECT * FROM thoughts
     WHERE thought_type = 'task'
     AND action_items != '{}'
     AND created_at > now() - make_interval(days => $1)
     ORDER BY created_at DESC`,
    [days]
  );
  return rows;
}
