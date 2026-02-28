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
    }),
  ]),
  tags: z.array(z.string()).max(5).describe('3-5 relevant tags for categorization'),
  reasoning: z.string().describe('Brief explanation of why this category was chosen'),
});

export type ClassificationOutput = z.infer<typeof ClassificationSchema>;
