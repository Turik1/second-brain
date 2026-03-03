import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const brainKey = req.headers['x-brain-key'] as string | undefined;

  const token =
    authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : brainKey;

  if (!token || !safeCompare(token, config.MCP_ACCESS_KEY)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
