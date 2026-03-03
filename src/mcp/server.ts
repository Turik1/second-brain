import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchThoughts, listRecent, getThoughtStats, listOpenTasks, updateThoughtStatus } from '../db/index.js';
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
      content: z.string().min(1).max(10000).describe('The thought to capture'),
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
            'Thought captured:',
            `- Title: ${thought.title ?? 'Untitled'}`,
            `- Type: ${thought.thought_type ?? 'unknown'}`,
            `- Topics: ${thought.topics?.join(', ') || 'none'}`,
            `- People: ${thought.people?.join(', ') || 'none'}`,
          ].join('\n'),
        }],
      };
    }
  );

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

  server.tool(
    'complete_thought',
    'Mark a thought/task as done by its ID.',
    { id: z.string().uuid().describe('The thought ID to mark as done') },
    async ({ id }) => {
      const updated = await updateThoughtStatus(id, 'done');
      if (!updated) return { content: [{ type: 'text' as const, text: `Thought ${id} not found.` }] };
      return {
        content: [{ type: 'text' as const, text: `Marked as done: ${updated.title ?? updated.content.slice(0, 50)}` }],
      };
    }
  );

  server.tool(
    'delete_thought',
    'Soft-delete a thought by its ID (sets status to cancelled).',
    { id: z.string().uuid().describe('The thought ID to delete') },
    async ({ id }) => {
      const updated = await updateThoughtStatus(id, 'cancelled');
      if (!updated) return { content: [{ type: 'text' as const, text: `Thought ${id} not found.` }] };
      return {
        content: [{ type: 'text' as const, text: `Deleted: ${updated.title ?? updated.content.slice(0, 50)}` }],
      };
    }
  );

  return server;
}
