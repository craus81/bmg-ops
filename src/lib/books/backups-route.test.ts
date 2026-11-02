// The routes of the backups of FleetSuite's books (part 84,
// src/lib/books/backups.ts): the nightly cron (the cron secret or a super
// admin, a response that says only how it went), Books → Backups' list (whoever
// opens the books) and Back up now (super admins, audited, one at a time), and
// the download (super admins, a five-minute link, audited). The backups
// themselves are held. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { BackupRunResult, BackupsView } from './backups';

const PAT = 'a0000000-0000-4000-8000-000000000001';
const BACKUP = 'b0000000-0000-4000-8000-000000000002';

const h = vi.hoisted(() => ({
  roles: ['admin', 'super_admin'],
  name: 'Pat Example' as string | null,
  run: vi.fn(),
  load: vi.fn(),
  link: vi.fn(),
  audits: [] as Array<Record<string, any>>,
}));

vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever h.roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  const who = () => ({ user: { id: PAT, email: 'pat@example.com' }, profile: { full_name: h.name } });
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => h.roles.includes(r));
      return booksAllows(access, need) ? { ...who(), access } : { error: new Response('Forbidden', { status: 403 }) };
    }),
    requireSuperAdmin: vi.fn(async () => (h.roles.includes('super_admin') ? who() : { error: new Response('Forbidden', { status: 403 }) })),
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async (_s: unknown, entry: Record<string, any>) => { h.audits.push(entry); }) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => ({ service: true }) }));
vi.mock('./backups', () => ({ runBackup: h.run, loadBackups: h.load, backupDownloadUrl: h.link }));

import { GET as cronGET, maxDuration as cronMaxDuration } from '../../app/api/cron/books-backup/route';
import { GET, POST, maxDuration } from '../../app/api/admin/books/backups/route';
import { GET as downloadGET } from '../../app/api/admin/books/backups/download/route';

const CRON = 'https://go.bmgfleet.com/api/cron/books-backup';
const PAGE = 'https://go.bmgfleet.com/api/admin/books/backups';
const cron = () => new NextRequest(CRON, { headers: { authorization: 'Bearer cron-secret' } });
const press = (body: unknown = { action: 'back_up' }) =>
  new NextRequest(PAGE, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const download = (id: string | null) => new NextRequest(`${PAGE}/download${id === null ? '' : `?id=${id}`}`);

const result = (over: Partial<BackupRunResult> = {}): BackupRunResult => ({
  state: 'made', id: BACKUP, startedAt: '2026-11-03T08:11:00.000Z', file: '2026/fleetsuite-books-2026-11-03-081100Z.zip',
  bytes: 1_258_291, error: null, heartbeat: { ok: true } as any, ...over,
});
const VIEW: BackupsView = {
  backups: [], lastMade: null, due: true, next: '2026-11-03T08:11:00.000Z', storageProblem: null,
};

beforeEach(() => {
  process.env.CRON_SECRET = 'cron-secret';
  h.roles = ['admin', 'super_admin'];
  h.name = 'Pat Example';
  h.run.mockReset().mockResolvedValue(result());
  h.load.mockReset().mockResolvedValue(VIEW);
  h.link.mockReset().mockResolvedValue({ url: 'https://r2.example/books-backups/x.zip?sig=1', fileName: 'fleetsuite-books-2026-11-03-081100Z.zip' });
  h.audits.length = 0;
});

describe('the nightly backup cron', () => {
  it('backs up with 270 seconds of its own, and says only how it went', async () => {
    const before = Date.now();
    const res = await cronGET(cron());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ booksBackup: 'made' });
    const [service, opts] = h.run.mock.calls[0];
    expect(service).toEqual({ service: true });
    expect(opts.how).toBe('nightly');
    expect(opts.by).toBeUndefined();
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 270_000);
    expect(opts.deadline).toBeLessThanOrEqual(Date.now() + 270_000);
    expect(cronMaxDuration).toBe(300);
  });

  it('says a failed or doubled run as it was, and never why', async () => {
    h.run.mockResolvedValue(result({ state: 'failed', error: 'Acme Fleet INV1001 broke it' }));
    expect(await (await cronGET(cron())).json()).toEqual({ booksBackup: 'failed' });
    h.run.mockResolvedValue(result({ state: 'running' }));
    expect(await (await cronGET(cron())).json()).toEqual({ booksBackup: 'running' });
  });

  it('says it failed when the run throws, and never what it was', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.run.mockRejectedValue(new Error('INV1001 for Acme Fleet'));
    const res = await cronGET(cron());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ booksBackup: 'failed' });
    expect(log).toHaveBeenCalledWith('[books] backup threw:', 'INV1001 for Acme Fleet');
    log.mockRestore();
  });

  it('turns away anyone without the cron secret who is not a super admin, and runs for one who is', async () => {
    h.roles = ['admin', 'bookkeeper'];
    expect((await cronGET(new NextRequest(CRON))).status).toBe(403);
    expect((await cronGET(new NextRequest(CRON, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(403);
    delete process.env.CRON_SECRET;
    expect((await cronGET(new NextRequest(CRON, { headers: { authorization: 'Bearer undefined' } }))).status).toBe(403);
    expect(h.run).not.toHaveBeenCalled();
    h.roles = ['admin', 'super_admin'];
    expect(await (await cronGET(new NextRequest(CRON))).json()).toEqual({ booksBackup: 'made' });
    expect(h.run.mock.calls[0][1].how).toBe('nightly');
  });
});

describe('Books → Backups', () => {
  it('lists the backups for whoever opens the books, the CPA too', async () => {
    for (const roles of [['admin', 'super_admin'], ['bookkeeper'], ['cpa']]) {
      h.roles = roles;
      const res = await GET(new NextRequest(PAGE));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(VIEW);
    }
    expect(h.load).toHaveBeenCalledWith({ service: true });
    h.roles = ['admin'];
    expect((await GET(new NextRequest(PAGE))).status).toBe(403);
  });

  it("says what went wrong when the list can't be read", async () => {
    h.load.mockRejectedValue(new Error("couldn't read the backups (timeout)"));
    const res = await GET(new NextRequest(PAGE));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "couldn't read the backups (timeout)" });
  });

  it('makes a backup by hand for a super admin, saying who asked, with the same budget as the nightly one, and audits it', async () => {
    const before = Date.now();
    const res = await POST(press());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: BACKUP, state: 'made', startedAt: '2026-11-03T08:11:00.000Z', file: '2026/fleetsuite-books-2026-11-03-081100Z.zip', bytes: 1_258_291,
    });
    const [service, opts] = h.run.mock.calls[0];
    expect(service).toEqual({ service: true });
    expect(opts).toMatchObject({ how: 'by_hand', by: PAT, byName: 'Pat Example' });
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 270_000);
    expect(opts.deadline).toBeLessThanOrEqual(Date.now() + 270_000);
    expect(maxDuration).toBe(300);
    expect(h.audits).toEqual([{
      actorId: PAT, table: 'books_backups', recordId: BACKUP, action: 'back_up_books',
      detail: { state: 'made', file: '2026/fleetsuite-books-2026-11-03-081100Z.zip', bytes: 1_258_291, error: null },
    }]);
  });

  it('names who asked by their email when their profile has no name', async () => {
    h.name = null;
    expect((await POST(press())).status).toBe(200);
    expect(h.run.mock.calls[0][1]).toMatchObject({ how: 'by_hand', by: PAT, byName: 'pat@example.com' });
  });

  it("says why a backup didn't work, and audits it", async () => {
    h.run.mockResolvedValue(result({ state: 'failed', file: null, bytes: null, error: 'It ran out of time with 40 of 90 tables copied.' }));
    const res = await POST(press());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ id: BACKUP, error: 'It ran out of time with 40 of 90 tables copied.' });
    expect(h.audits).toEqual([expect.objectContaining({
      recordId: BACKUP, action: 'back_up_books', detail: { state: 'failed', file: null, bytes: null, error: 'It ran out of time with 40 of 90 tables copied.' },
    })]);
    // One that couldn't even start has no backup to name.
    h.run.mockResolvedValue(result({ state: 'failed', id: null, startedAt: null, file: null, bytes: null, error: "Couldn't start a backup: down" }));
    expect(await (await POST(press())).json()).toEqual({ id: null, error: "Couldn't start a backup: down" });
    expect(h.audits[1]).toMatchObject({ recordId: null, action: 'back_up_books' });
  });

  it('says one is already running, since when, and makes no second one or audit', async () => {
    h.run.mockResolvedValue(result({ state: 'running', file: null, bytes: null }));
    const res = await POST(press());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "A backup is already running. It began November 3, 2026 at 2:11 AM Central. How it went shows here when it's done.",
    });
    h.run.mockResolvedValue(result({ state: 'running', id: null, startedAt: null, file: null, bytes: null }));
    expect(await (await POST(press())).json()).toEqual({ error: "A backup is already running. How it went shows here when it's done." });
    expect(h.audits).toEqual([]);
  });

  it('lets only a super admin back up, and only when asked to', async () => {
    for (const roles of [['bookkeeper'], ['cpa'], ['admin']]) {
      h.roles = roles;
      expect((await POST(press())).status).toBe(403);
    }
    h.roles = ['admin', 'super_admin'];
    expect((await POST(press({ action: 'restore' }))).status).toBe(400);
    expect((await POST(press({}))).status).toBe(400);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
  });
});

describe('downloading a backup', () => {
  it("hands a super admin a five-minute link to the backup's zip, never kept, and audits it", async () => {
    const res = await downloadGET(download(BACKUP));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ url: 'https://r2.example/books-backups/x.zip?sig=1', fileName: 'fleetsuite-books-2026-11-03-081100Z.zip' });
    expect(h.link).toHaveBeenCalledWith({ service: true }, BACKUP);
    expect(h.audits).toEqual([{
      actorId: PAT, table: 'books_backups', recordId: BACKUP, action: 'download_books_backup', detail: { file: 'fleetsuite-books-2026-11-03-081100Z.zip' },
    }]);
  });

  it('says so for a backup with no file, or no backup named, and audits neither', async () => {
    h.link.mockResolvedValue(null);
    const none = await downloadGET(download(BACKUP));
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'That backup has no file to download.' });
    for (const id of [null, '', 'not-a-backup', `${BACKUP}x`]) expect((await downloadGET(download(id))).status).toBe(400);
    h.link.mockRejectedValue(new Error("couldn't read the backup (timeout)"));
    const broken = await downloadGET(download(BACKUP));
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: "couldn't read the backup (timeout)" });
    expect(h.audits).toEqual([]);
  });

  it('lets only a super admin download one: a backup holds every table of the books', async () => {
    for (const roles of [['bookkeeper'], ['cpa'], ['admin']]) {
      h.roles = roles;
      expect((await downloadGET(download(BACKUP))).status).toBe(403);
    }
    expect(h.link).not.toHaveBeenCalled();
  });
});
