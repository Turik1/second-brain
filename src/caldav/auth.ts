import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/** Validate Basic Auth credentials using timing-safe comparison */
export function validateBasicAuth(
  authHeader: string | undefined,
  expectedUser: string,
  expectedPass: string,
): boolean {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) return false;

    const user = decoded.slice(0, colonIndex);
    const pass = decoded.slice(colonIndex + 1);

    const userBuf = Buffer.from(user);
    const passBuf = Buffer.from(pass);
    const expectedUserBuf = Buffer.from(expectedUser);
    const expectedPassBuf = Buffer.from(expectedPass);

    // Length check before timing-safe compare (timingSafeEqual requires same length)
    const userMatch =
      userBuf.length === expectedUserBuf.length &&
      timingSafeEqual(userBuf, expectedUserBuf);
    const passMatch =
      passBuf.length === expectedPassBuf.length &&
      timingSafeEqual(passBuf, expectedPassBuf);

    return userMatch && passMatch;
  } catch {
    return false;
  }
}

/** Express middleware that enforces Basic Auth on CalDAV routes */
export async function caldavAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Lazy imports to avoid eager config validation at module load time
  const { config } = await import('../config.js');
  const { logger } = await import('../utils/logger.js');

  const username = config.CALDAV_USERNAME;
  const password = config.CALDAV_PASSWORD;

  if (!username || !password) {
    logger.error({ event: 'caldav_auth_misconfigured' }, 'CalDAV credentials not set');
    res.status(500).send('CalDAV not configured');
    return;
  }

  const authHeader = req.headers['authorization'] as string | undefined;

  if (validateBasicAuth(authHeader, username, password)) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Second Brain CalDAV"');
    res.status(401).send('Unauthorized');
  }
}
