import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { canSeeRequest, updateRecipients, pageName, excerpt, isClosed, AGENT_STATUSES } from './app-requests';
import { authenticateRequestsAgent } from './app-requests-agent';

describe('who can see a request', () => {
  it('lets staff see everyone\'s and others only their own', () => {
    expect(canSeeRequest({ id: 'a', staff: true }, { created_by: 'b' })).toBe(true);
    expect(canSeeRequest({ id: 'a', staff: false }, { created_by: 'a' })).toBe(true);
    expect(canSeeRequest({ id: 'a', staff: false }, { created_by: 'b' })).toBe(false);
    expect(canSeeRequest({ id: 'a', staff: false }, { created_by: null })).toBe(false);
  });
});

describe('who hears about a change', () => {
  it('is the sender, the Me too people and the watchers, once each, less the actor', () => {
    expect(updateRecipients({ submitter: 's', meToo: ['m', 'craig'], watchers: ['craig'], actor: null }).sort())
      .toEqual(['craig', 'm', 's']);
    // Craig replying doesn't alert Craig.
    expect(updateRecipients({ submitter: 's', meToo: [], watchers: ['craig'], actor: 'craig' })).toEqual(['s']);
    // The sender adding detail tells Craig, not themselves.
    expect(updateRecipients({ submitter: 's', meToo: [], watchers: ['craig'], actor: 's' })).toEqual(['craig']);
  });
});

describe('labels', () => {
  it('names the screen a request came from', () => {
    expect(pageName('/admin/scans?tab=2')).toBe('Scan Log');
    expect(pageName('/scan')).toBe('Scan & Log');
    expect(pageName('/somewhere/new')).toBe('/somewhere/new');
    expect(pageName(null)).toBeNull();
  });
  it('trims a request to one line', () => {
    expect(excerpt('two\n  lines')).toBe('two lines');
    expect(excerpt('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
  it('keeps Won\'t do away from Claude and under Closed', () => {
    expect(AGENT_STATUSES).not.toContain('wont');
    expect(isClosed('wont')).toBe(true);
    expect(isClosed('waiting')).toBe(false);
  });
});

describe('the agent token', () => {
  const saved = process.env.REQUESTS_AGENT_TOKEN;
  afterEach(() => { process.env.REQUESTS_AGENT_TOKEN = saved; });
  const req = (auth?: string) => new NextRequest('https://go.bmgfleet.com/api/requests/agent', { headers: auth ? { authorization: auth } : {} });

  it('refuses everything while no token is set', () => {
    delete process.env.REQUESTS_AGENT_TOKEN;
    expect(authenticateRequestsAgent(req('Bearer anything'))).toMatchObject({ ok: false, status: 503 });
  });
  it('takes only the exact token', () => {
    process.env.REQUESTS_AGENT_TOKEN = 'a'.repeat(32);
    expect(authenticateRequestsAgent(req(`Bearer ${'a'.repeat(32)}`))).toEqual({ ok: true });
    expect(authenticateRequestsAgent(req(`Bearer ${'a'.repeat(31)}b`))).toMatchObject({ ok: false, status: 401 });
    expect(authenticateRequestsAgent(req())).toMatchObject({ ok: false, status: 401 });
  });
});
