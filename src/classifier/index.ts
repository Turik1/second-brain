import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { ClassificationError } from '../utils/errors.js';
import { ClassificationSchema, type ClassificationOutput } from './schemas.js';
import { CLASSIFICATION_SYSTEM_PROMPT } from './prompt.js';
import type { Category, ClassificationResult } from '../types.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface ClassifyOptions {
  forceCategory?: Category;
}

export async function classify(
  messageText: string,
  options: ClassifyOptions = {},
): Promise<ClassificationResult> {
  const startMs = Date.now();

  const systemPrompt = options.forceCategory
    ? `${CLASSIFICATION_SYSTEM_PROMPT}\n\nIMPORTANT: The user has explicitly requested this be filed as category "${options.forceCategory}". You MUST use this category and set confidence to 1.0.`
    : CLASSIFICATION_SYSTEM_PROMPT;

  try {
    const output = await withRetry(
      async () => {
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: messageText }],
          output_config: {
            format: zodOutputFormat(ClassificationSchema),
          },
        });

        // Extract text content and parse
        const textBlock = response.content.find((b) => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
          throw new ClassificationError('No text content in classification response');
        }

        const parsed = ClassificationSchema.parse(JSON.parse(textBlock.text));
        return parsed;
      },
      {
        attempts: 3,
        baseDelayMs: 1000,
        onRetry: (err, attempt) => {
          logger.warn({ attempt, error: err }, 'Classification retry');
        },
      },
    );

    const processingTimeMs = Date.now() - startMs;
    logger.info(
      {
        category: output.category,
        confidence: output.confidence,
        processingTimeMs,
      },
      'Classification complete',
    );

    return toClassificationResult(output);
  } catch (err) {
    if (err instanceof ClassificationError) throw err;
    throw new ClassificationError('Classification failed', err);
  }
}

function toClassificationResult(output: ClassificationOutput): ClassificationResult {
  const extras: Record<string, unknown> = {};

  const fields = output.extracted_fields;
  if (fields.category === 'people') {
    extras['name'] = fields.name;
    extras['relationship'] = fields.relationship;
    extras['context'] = fields.context;
  } else if (fields.category === 'projects') {
    extras['status'] = fields.status;
    extras['description'] = fields.description;
    extras['priority'] = fields.priority;
    extras['next_action'] = fields.next_action;
  } else if (fields.category === 'ideas') {
    extras['idea_category'] = fields.idea_category;
    extras['description'] = fields.description;
    extras['potential'] = fields.potential;
  } else if (fields.category === 'admin') {
    extras['type'] = fields.type;
    extras['due_date'] = fields.due_date;
    extras['status'] = fields.status;
    extras['priority'] = fields.priority;
  }

  extras['reasoning'] = output.reasoning;

  return {
    category: output.category as Category,
    confidence: output.confidence,
    title: output.title,
    summary: output.reasoning,
    tags: output.tags,
    extras,
    intent: output.intent,
    searchQuery: output.search_query,
  };
}
