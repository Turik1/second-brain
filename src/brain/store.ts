import { generateEmbedding } from '../embeddings/index.js';
import { extractMetadata } from '../extractor/index.js';
import { insertThought } from '../db/index.js';
import { logger } from '../utils/logger.js';
import type { Thought } from '../db/index.js';

export interface CaptureInput {
  content: string;
  source?: string;
  source_id?: string;
  chat_id?: number;
}

export async function captureThought(input: CaptureInput): Promise<Thought | null> {
  try {
    const [embedding, metadata] = await Promise.all([
      generateEmbedding(input.content, 'document'),
      extractMetadata(input.content),
    ]);

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

    logger.info(
      { thoughtId: thought?.id, type: metadata.thought_type, title: metadata.title },
      'Thought captured'
    );

    return thought;
  } catch (err) {
    logger.error({ error: err, content: input.content.slice(0, 100) }, 'Failed to capture thought');
    return null;
  }
}
