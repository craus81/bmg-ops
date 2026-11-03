// The routes of Books → How the books work (part 88,
// src/app/api/admin/books/how-it-works): the page's view and its PDF for
// whoever opens the books, and Mark reviewed for the CPA, or a super admin
// writing down the CPA's review on paper, kept with the rules the reviewer
// saw and audited. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const PAT = 'a0000000-0000-4000-8000-000000000001';
const REVIEW = 'd0000000-0000-4000-8000-000000000007';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  roles: ['cpa'] as string[],
  name: 'Pat Example' as string | null,
  email: 'pat@example.com' as string | null,
  load: vi.fn(),
  pdf: vi.fn(),
  inserted: [] as Row[],
  insertError: null as string | null,
  audits: [] as Array<Record<string, any>>,
}));

vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever h.roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  const who = () => ({ user: { id: PAT, email: h.email }, profile: { full_name: h.name, roles: h.roles } });
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => h.roles.includes(r));
      return booksAllows(access, need) ? { ...who(), access } : { error: new Response('Forbidden', { status: 403 }) };
    }),
    getProfileRoles: vi.fn((profile: { roles: string[] }) => profile.roles),
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async (_s: unknown, entry: Record<string, any>) => { h.audits.push(entry); }) }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      insert: (row: Row) => ({
        select: () => ({
          single: async () => {
            if (table !== 'books_rules_reviews') throw new Error(`wrote to ${table}`);
            if (h.insertError) return { data: null, error: { message: h.insertError } };
            h.inserted.push(row);
            return { data: { id: REVIEW, reviewed_at: '2026-11-03T15:00:00Z' }, error: null };
          },
        }),
      }),
    }),
  }),
}));
vi.mock('./how-it-works-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./how-it-works-data')>()),
  loadHowItWorks: h.load,
}));
vi.mock('./how-it-works-pdf', () => ({ howItWorksPdf: h.pdf }));

import { GET, POST } from '../../app/api/admin/books/how-it-works/route';
import { GET as downloadGET } from '../../app/api/admin/books/how-it-works/download/route';
import { RULE_IDS } from './how-it-works';
import { rulesFingerprint } from './how-it-works-data';

const PAGE = 'https://go.bmgfleet.com/api/admin/books/how-it-works';
const VIEW = { asOf: '2026-11-03T15:00:00.000Z', problems: [], made: 'up' };
const mark = (body: unknown) => new NextRequest(PAGE, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const reviewed = (over: Record<string, unknown> = {}) => mark({ action: 'reviewed', fingerprint: rulesFingerprint(), ...over });

beforeEach(() => {
  h.roles = ['cpa'];
  h.name = 'Pat Example';
  h.email = 'pat@example.com';
  h.load.mockReset().mockResolvedValue(VIEW);
  h.pdf.mockReset().mockReturnValue({ bytes: Buffer.from('%PDF-1.3 made up'), name: 'How-the-books-work-2026-11-03.pdf', type: 'application/pdf' });
  h.inserted = [];
  h.insertError = null;
  h.audits = [];
});

describe('GET /api/admin/books/how-it-works', () => {
  it("is shut to anyone who doesn't open the books", async () => {
    h.roles = ['admin', 'sales'];
    expect((await GET(new NextRequest(PAGE))).status).toBe(403);
    expect(h.load).not.toHaveBeenCalled();
  });

  it('reads the books as they are now for the bookkeeper, the CPA and super admins, with who is looking', async () => {
    for (const roles of [['bookkeeper'], ['cpa'], ['admin', 'super_admin']]) {
      h.roles = roles;
      h.load.mockClear();
      const res = await GET(new NextRequest(PAGE));
      expect(res.status, roles.join()).toBe(200);
      expect(await res.json()).toEqual(VIEW);
      expect(h.load).toHaveBeenCalledWith(expect.anything(), { roles });
    }
  });

  it("says plainly when the books can't be read", async () => {
    h.load.mockRejectedValue(new Error('the database is down'));
    const res = await GET(new NextRequest(PAGE));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'the database is down' });
  });
});

describe('POST /api/admin/books/how-it-works: Mark reviewed', () => {
  it('keeps the CPA\'s review with who, as what, the rules and their fingerprint, and audits it', async () => {
    const res = await POST(reviewed({ note: '  Signed the PDF dated Nov 3.  ' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: REVIEW, reviewedAt: '2026-11-03T15:00:00Z', reviewedAs: 'cpa' });
    expect(h.inserted).toEqual([{
      reviewed_by: PAT, reviewed_by_name: 'Pat Example', reviewed_as: 'cpa', rules: [...RULE_IDS], fingerprint: rulesFingerprint(),
      note: 'Signed the PDF dated Nov 3.',
    }]);
    expect(h.audits).toEqual([{
      actorId: PAT, table: 'books_rules_reviews', recordId: REVIEW, action: 'reviewed',
      detail: { reviewed_as: 'cpa', rules: RULE_IDS.length, fingerprint: rulesFingerprint(), note: true },
    }]);
  });

  it("lets a super admin write down the CPA's review on paper, and the CPA's own counts as the CPA's", async () => {
    h.roles = ['admin', 'super_admin'];
    expect((await POST(reviewed())).status).toBe(200);
    expect(h.inserted[0]).toMatchObject({ reviewed_as: 'super_admin', note: null });
    expect(h.audits[0].detail).toEqual({ reviewed_as: 'super_admin', rules: RULE_IDS.length, fingerprint: rulesFingerprint(), note: false });
    h.roles = ['cpa', 'super_admin'];
    expect((await POST(reviewed())).status).toBe(200);
    expect(h.inserted[1]).toMatchObject({ reviewed_as: 'cpa' });
  });

  it('turns away the bookkeeper and anyone outside the books, keeping nothing', async () => {
    h.roles = ['bookkeeper'];
    const res = await POST(reviewed());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only the CPA, or a super admin writing down the CPA's review, marks this reviewed.");
    h.roles = ['admin', 'executive'];
    expect((await POST(reviewed())).status).toBe(403);
    expect(h.inserted).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('refuses a review of rules that changed since the page opened', async () => {
    const res = await POST(reviewed({ fingerprint: 'f'.repeat(64) }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('How the books work changed since this page opened. Read it again, then mark it reviewed.');
    expect(h.inserted).toEqual([]);
  });

  it("takes a note as the table does, and refuses what isn't a review", async () => {
    expect((await POST(reviewed({ note: '   ' }))).status).toBe(200);
    expect(h.inserted[0].note).toBeNull();
    const long = await POST(reviewed({ note: 'x'.repeat(601) }));
    expect(long.status).toBe(400);
    expect((await long.json()).error).toBe('A note is 600 characters at most.');
    expect((await POST(reviewed({ note: `  ${'x'.repeat(600)}  ` }))).status).toBe(200);
    expect(h.inserted[1].note).toBe('x'.repeat(600));
    for (const bad of [{ action: 'approve' }, { fingerprint: 'abc' }, { fingerprint: 'A'.repeat(64) }, { note: 7 }]) {
      expect((await POST(reviewed(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(h.inserted).toHaveLength(2);
  });

  it("names the reviewer by their name, else their email, as the table takes it", async () => {
    h.name = null;
    await POST(reviewed());
    expect(h.inserted[0].reviewed_by_name).toBe('pat@example.com');
    h.name = `${'P'.repeat(199)} and more`;
    await POST(reviewed());
    expect(h.inserted[1].reviewed_by_name).toBe('P'.repeat(199));
    h.name = '  ';
    h.email = null;
    await POST(reviewed());
    expect(h.inserted[2].reviewed_by_name).toBe('Someone');
  });

  it("says when the review wasn't kept, and audits nothing", async () => {
    h.insertError = 'books_rules_reviews_note_check';
    const res = await POST(reviewed());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("The review wasn't kept (books_rules_reviews_note_check)");
    expect(h.audits).toEqual([]);
  });
});

describe('GET /api/admin/books/how-it-works/download', () => {
  it('hands whoever opens the books the PDF dated now, made from the same view as the page', async () => {
    h.roles = ['bookkeeper'];
    const res = await downloadGET(new NextRequest(`${PAGE}/download`));
    expect(res.status).toBe(200);
    expect(h.load).toHaveBeenCalledWith(expect.anything(), { roles: ['bookkeeper'] });
    expect(h.pdf).toHaveBeenCalledWith(VIEW);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('filename="How-the-books-work-2026-11-03.pdf"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await res.arrayBuffer()).toString('latin1')).toBe('%PDF-1.3 made up');
  });

  it("is shut to anyone who doesn't open the books, and says when the books can't be read", async () => {
    h.roles = ['sales'];
    expect((await downloadGET(new NextRequest(`${PAGE}/download`))).status).toBe(403);
    h.roles = ['cpa'];
    h.load.mockRejectedValue(new Error('the database is down'));
    const res = await downloadGET(new NextRequest(`${PAGE}/download`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'the database is down' });
  });
});
