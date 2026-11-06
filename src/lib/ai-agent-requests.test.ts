import { describe, it, expect, vi, beforeEach } from 'vitest';

const notify = vi.fn(async (_p: any) => ({ inApp: true, sms: false, email: true, push: true }));
vi.mock('./notify', () => ({ notify: (p: any) => notify(p) }));
vi.mock('./new-alert-watchers', () => ({ newAlertWatcherIds: async () => ['craig'] }));
const alertNewRequest = vi.fn(async () => {});
const alertRequestUpdate = vi.fn(async () => {});
vi.mock('./app-requests-server', () => ({
  REQUEST_SELECT: '*',
  alertNewRequest: (...a: any[]) => (alertNewRequest as any)(...a),
  alertRequestUpdate: (...a: any[]) => (alertRequestUpdate as any)(...a),
}));

import {
  ANY_ROLE_ACTIONS, AI_REQUEST_DEVICE, addToRequestFromChat, chatTranscript, fileRequestFromChat,
  normalizeKind, notifyFromChat, requestBody, type ChatCaller,
} from './ai-agent-requests';

/** A tiny stand-in for the service client: records inserts, answers selects. */
function fakeService(opts: { existing?: any } = {}) {
  const inserts: Record<string, any[]> = {};
  const updates: any[] = [];
  const from = (table: string) => {
    const q: any = {
      _filters: {} as Record<string, any>,
      insert(row: any) { (inserts[table] ||= []).push(row); q._row = row; return q; },
      update(row: any) { updates.push({ table, row }); q._row = { ...(opts.existing || {}), ...row }; return q; },
      select() { return q; },
      eq(k: string, v: any) { q._filters[k] = v; return q; },
      async single() {
        if (table === 'app_requests' && q._row) return { data: { id: 'req-1', number: 47, status: 'new', ...q._row }, error: null };
        return { data: null, error: null };
      },
      async maybeSingle() {
        const e = opts.existing;
        const match = e && Object.entries(q._filters).every(([k, v]) => e[k] === v);
        return { data: match ? e : null, error: null };
      },
      then(res: any) { return Promise.resolve({ error: null }).then(res); },
    };
    return q;
  };
  return { service: { from } as any, inserts, updates };
}

const caller: ChatCaller = {
  id: 'brian',
  name: 'Brian',
  pagePath: '/admin/job-stages',
  messages: [
    { role: 'user', content: 'Parts in didn\'t turn green for SO1241' },
    { role: 'assistant', content: 'Let me check.' },
  ],
};

beforeEach(() => { notify.mockClear(); alertNewRequest.mockClear(); alertRequestUpdate.mockClear(); });

describe('FleetSuite AI hands things to Craig', () => {
  it('maps bug to problem and anything unknown to question', () => {
    expect(normalizeKind('bug')).toBe('problem');
    expect(normalizeKind('Idea')).toBe('idea');
    expect(normalizeKind('whatever')).toBe('question');
  });

  it('lets every chat role file and add to requests', () => {
    expect(ANY_ROLE_ACTIONS.has('file_request')).toBe(true);
    expect(ANY_ROLE_ACTIONS.has('add_to_request')).toBe(true);
    expect(ANY_ROLE_ACTIONS.has('create_estimate')).toBe(false);
  });

  it('puts their words first, then findings, then the chat', () => {
    const body = requestBody({ summary: 'Bar stuck', findings: 'Both POs received', transcript: chatTranscript(caller.messages, 'Brian') });
    expect(body.indexOf('Bar stuck')).toBe(0);
    expect(body).toContain('What FleetSuite AI found:\nBoth POs received');
    expect(body).toContain('Brian: Parts in didn\'t turn green');
    expect(body).toContain('FleetSuite AI: Let me check.');
  });

  it('files a request in the caller\'s name and alerts at once', async () => {
    const { service, inserts } = fakeService();
    const r = await fileRequestFromChat(service, caller, { kind: 'bug', summary: 'Bar stuck on SO1241', findings: 'POs received Nov 5' });
    expect(inserts.app_requests[0]).toMatchObject({ kind: 'problem', created_by: 'brian', from_page: '/admin/job-stages', device: AI_REQUEST_DEVICE });
    expect(r.request).toEqual({ id: 'req-1', number: 47 });
    expect(alertNewRequest).toHaveBeenCalledTimes(1);
    expect((alertNewRequest as any).mock.calls[0][2]).toBe('Brian (via FleetSuite AI)');
  });

  it('refuses a request with nothing in it', async () => {
    const { service } = fakeService();
    await expect(fileRequestFromChat(service, caller, { kind: 'idea', summary: '  ' })).rejects.toThrow(/summary required/);
  });

  it('adds only to the caller\'s own request', async () => {
    const mine = fakeService({ existing: { id: 'req-1', number: 47, status: 'new', created_by: 'brian' } });
    const r = await addToRequestFromChat(mine.service, caller, { number: 47, body: 'Also SO1250' });
    expect(mine.inserts.app_request_messages[0]).toMatchObject({ request_id: 'req-1', author_id: 'brian', body: 'Also SO1250' });
    expect(r.request.number).toBe(47);
    expect(alertRequestUpdate).toHaveBeenCalledTimes(1);

    const theirs = fakeService({ existing: { id: 'req-2', number: 48, status: 'new', created_by: 'valarie' } });
    await expect(addToRequestFromChat(theirs.service, caller, { number: 48, body: 'x' })).rejects.toThrow(/isn't one this person sent/);
  });

  it('sends notifications as real alerts and copies Craig', async () => {
    const { service } = fakeService();
    const sent = await notifyFromChat(service, caller, { user_id: 'jessie', title: 'Parts here', body: 'SO1241 parts in', url: '/x' });
    expect(sent).toEqual(['jessie', 'craig']);
    expect(notify).toHaveBeenCalledTimes(2);
    expect((notify.mock.calls as any[])[1][0]).toMatchObject({ userId: 'craig', title: 'Copy: Parts here' });
  });

  it('does not copy Craig on an alert that is already to him', async () => {
    const { service } = fakeService();
    const sent = await notifyFromChat(service, caller, { user_id: 'craig', title: 'Hi', body: 'b', url: null });
    expect(sent).toEqual(['craig']);
  });
});
