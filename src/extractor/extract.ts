import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const ThoughtMetadataSchema = z.object({
  title: z.string().max(80),
  thought_type: z.enum([
    'task', 'person_note', 'idea', 'project', 'insight', 'decision', 'meeting',
  ]),
  topics: z.array(z.string()).max(5),
  people: z.array(z.string()),
  action_items: z.array(z.string()),
});

export type ThoughtMetadata = z.infer<typeof ThoughtMetadataSchema>;

const SYSTEM_PROMPT = `Du bist ein Metadaten-Extraktor. Analysiere die Nachricht und extrahiere strukturierte Metadaten. Antworte NUR mit einem JSON-Objekt, ohne Erklärung.

Regeln:
- title: Kurze Zusammenfassung (max 80 Zeichen), auf Deutsch
- thought_type: Wähle die passendste Kategorie:
  - task: Aufgaben, Erinnerungen, Termine, Erledigungen
  - person_note: Notizen über Personen, Treffen, Kontakte
  - idea: Ideen, Konzepte, kreative Gedanken
  - project: Projektbezogene Notizen, Fortschritt, Meilensteine
  - insight: Erkenntnisse, Learnings, Aha-Momente
  - decision: Entscheidungen mit Kontext
  - meeting: Meeting-Notizen, Gesprächszusammenfassungen
- topics: Bis zu 5 relevante Themen-Tags (kurze Wörter)
- people: Alle erwähnten Personennamen
- action_items: Konkrete nächste Schritte oder Aufgaben (leer wenn keine)`;

export async function extractMetadata(content: string): Promise<ThoughtMetadata> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn({ content, response: text }, 'No JSON in extraction response, using defaults');
    return {
      title: content.slice(0, 80),
      thought_type: 'insight',
      topics: [],
      people: [],
      action_items: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return ThoughtMetadataSchema.parse(parsed);
  } catch (err) {
    logger.warn({ content, response: text, error: err }, 'Failed to parse extraction response, using defaults');
    return {
      title: content.slice(0, 80),
      thought_type: 'insight',
      topics: [],
      people: [],
      action_items: [],
    };
  }
}
