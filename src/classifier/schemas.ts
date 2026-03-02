import { z } from 'zod';

export const ClassificationSchema = z.object({
  category: z.enum(['people', 'projects', 'ideas', 'admin']),
  confidence: z.number().min(0).max(1),
  title: z.string().describe('Short summary for the Notion page title, max 80 chars'),
  extracted_fields: z.discriminatedUnion('category', [
    z.object({
      category: z.literal('people'),
      name: z.string(),
      relationship: z.enum([
        'friend',
        'colleague',
        'acquaintance',
        'family',
        'professional-contact',
      ]),
      context: z.string(),
    }),
    z.object({
      category: z.literal('projects'),
      status: z.enum(['idea', 'active', 'blocked', 'completed', 'archived']),
      description: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
      next_action: z.string().nullable().describe(
        'Concrete next physical action to move this project forward. Extract if mentioned, null otherwise.',
      ),
    }),
    z.object({
      category: z.literal('ideas'),
      idea_category: z.enum(['business', 'technical', 'creative', 'personal', 'research']),
      description: z.string(),
      potential: z.enum(['high', 'medium', 'low', 'unknown']),
    }),
    z.object({
      category: z.literal('admin'),
      type: z.enum(['task', 'reminder', 'appointment', 'errand', 'note']),
      due_date: z.string().nullable().describe('ISO date string if mentioned, null otherwise'),
      status: z.literal('pending'),
      priority: z.enum(['high', 'medium', 'low']).describe(
        'Priority: high for appointments/deadlines/urgent items, medium for standard tasks/errands, low for notes/non-urgent items',
      ),
    }),
  ]),
  tags: z.array(z.string()).max(5).describe('3-5 relevant tags for categorization'),
  reasoning: z.string().describe('Brief explanation of why this category was chosen'),
  intent: z.enum(['new', 'update', 'done']).describe(
    'Whether the user wants to create a new entry, update an existing one, or mark one as done/completed',
  ),
  search_query: z.string().nullable().describe(
    'For update/done intents: the name or title to search for in Notion (1-3 distinctive words). null for new intent.',
  ),
  related_entries: z.array(z.object({
    search_query: z.string().describe('1-3 distinctive words to find the related entry in Notion'),
    target_category: z.enum(['people', 'projects', 'ideas', 'admin']),
    relationship: z.string().describe('Brief description of the relationship, e.g. "works on this project"'),
  })).max(3).default([]).describe(
    'References to existing entries in other categories. Only include if the message clearly references known people, projects, ideas, or tasks by name.',
  ),
});

export type ClassificationOutput = z.infer<typeof ClassificationSchema>;
