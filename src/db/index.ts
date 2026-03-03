export { pool, closePool } from './pool.js';
export { runMigrations } from './migrate.js';
export { insertThought, searchThoughts, listRecent, getThoughtStats, listTasksWithActions,
  listOpenTasks, listOverdue, listDueToday, updateThoughtStatus, updateThoughtDueDate, findThoughtBySourceId, getOpenTaskStats,
  insertKnowledge, listKnowledge, deleteKnowledge
} from './queries.js';
export type { Thought, ThoughtInsert, KnowledgeFact } from './queries.js';
