export type Category = 'people' | 'projects' | 'ideas' | 'admin' | 'unknown';

export type InboxStatus = 'processed' | 'pending' | 'failed' | 're-classified' | 'expired';

export interface ClassificationResult {
  category: Category;
  confidence: number;
  title: string;
  summary: string;
  tags: string[];
  extras: Record<string, unknown>;
}

export interface InboxEntry {
  telegramMessageId: number;
  chatId: number;
  text: string;
  receivedAt: Date;
}

export interface ProcessingResult {
  inboxLogPageId: string;
  targetPageId?: string;
  category: Category;
  confidence: number;
  processingTimeMs: number;
  status: InboxStatus;
}
