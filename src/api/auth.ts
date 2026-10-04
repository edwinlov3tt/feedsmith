import type { MiddlewareHandler } from 'hono';
import { safeEqual } from '../core/crypto.ts';

/**
 * Operator API auth: `Authorization: Bearer <ADMIN_TOKEN>`. Single-operator
 * machine credential, not a user session (see ADR-0001). Fails closed when the
 * secret isn't configured.
 */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected || expected.length < 24) {
    return c.json({ error: 'admin API disabled: ADMIN_TOKEN is not configured' }, 503);
  }
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1] || !(await safeEqual(match[1], expected))) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
  return undefined;
};

/** Parses HTTP Basic credentials; null when absent or malformed. */
export function basicCredentials(header: string | undefined): { user: string; password: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!m?.[1]) return null;
  let decoded: string;
  try {
    decoded = atob(m[1]);
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  return i < 0 ? null : { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}
