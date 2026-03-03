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
  due_date: z.string().nullable().optional(),
  priority: z.enum(['high', 'medium', 'low']).nullable().optional(),
});

export type ThoughtMetadata = z.infer<typeof ThoughtMetadataSchema>;

export async function extractMetadata(content: string): Promise<ThoughtMetadata> {
  const today = new Date().toISOString().split('T')[0];
  const systemPrompt = `Du bist ein Metadaten-Extraktor. Analysiere die Nachricht und extrahiere strukturierte Metadaten. Antworte NUR mit einem JSON-Objekt, ohne Erklärung.

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
- action_items: Konkrete nächste Schritte oder Aufgaben (leer wenn keine)
- due_date: ISO-Datum (YYYY-MM-DD) wenn ein konkretes Datum oder relativer Zeitbezug im Text vorkommt ("morgen", "nächsten Freitag", "bis Ende März"). Heute ist ${today}. null wenn kein Datum erkennbar.
- priority: "high", "medium", oder "low" wenn Dringlichkeit erkennbar ("dringend", "wichtig", "asap" = high, "irgendwann", "wenn Zeit ist" = low). null wenn keine Dringlichkeit erkennbar.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
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
      due_date: null,
      priority: null,
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
      due_date: null,
      priority: null,
    };
  }
}
