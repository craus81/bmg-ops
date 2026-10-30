import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

/**
 * Claude's scheduled check authenticates with REQUESTS_AGENT_TOKEN as a
 * Bearer token. No session, no user: it can only read requests and write
 * Claude's replies and statuses (never Won't do).
 */
export function authenticateRequestsAgent(req: NextRequest): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.REQUESTS_AGENT_TOKEN || '';
  if (expected.length < 24) return { ok: false, status: 503, error: 'Requests agent token is not configured' };
  const header = req.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, error: 'Unauthorized' };
  return { ok: true };
}
