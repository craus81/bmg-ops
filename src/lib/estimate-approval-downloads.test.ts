import { describe, it, expect } from 'vitest';
import { approvalDownloadUrls, attachmentDisposition, loadApprovalDownloads } from './estimate-approval-downloads';

function fakeService(rows: any[]) {
  const calls: any[] = [];
  const q: any = {
    select: () => q, in: (col: string, v: any) => { calls.push(['in', col, v]); return q; },
    eq: (col: string, v: any) => { calls.push(['eq', col, v]); return q; },
    then: (resolve: any) => resolve({ data: rows, error: null }),
  };
  return { service: { from: () => q } as any, calls };
}

describe('approvalDownloadUrls', () => {
  it('builds every link under the token, on our own domain', () => {
    const u = approvalDownloadUrls('https://go.bmgfleet.com', 'tok/en');
    expect(u.pdf).toBe('https://go.bmgfleet.com/api/approve/estimate/tok%2Fen/download/pdf');
    expect(u.file('f1')).toBe('https://go.bmgfleet.com/api/approve/estimate/tok%2Fen/download/file/f1');
    expect(u.proof('p1')).toBe('https://go.bmgfleet.com/api/approve/estimate/tok%2Fen/proof/p1?download=1');
  });
});

describe('loadApprovalDownloads', () => {
  it('lists the PDF first, then only the pinned files that belong to the estimate, then the proofs', async () => {
    const { service, calls } = fakeService([{ id: 'b', file_name: 'Spec sheet.pdf' }, { id: 'a', file_name: 'Logo.png' }]);
    const list = await loadApprovalDownloads(
      service,
      { id: 'est1', estimate_number: 'EST-2610-014', approval_file_ids: ['a', 'b', 'gone'] },
      [{ jobId: 'j', jobNumber: '4821', jobTitle: 'Decals', files: [{ id: 'p1', name: 'Proof_1A.jpg', url: null, isPdf: false, storagePath: 'x' }] }],
      '',
      'tok',
    );
    expect(list.map(d => [d.kind, d.name, d.url])).toEqual([
      ['pdf', 'Estimate-EST-2610-014.pdf', '/api/approve/estimate/tok/download/pdf'],
      ['file', 'Logo.png', '/api/approve/estimate/tok/download/file/a'],
      ['file', 'Spec sheet.pdf', '/api/approve/estimate/tok/download/file/b'],
      ['proof', 'Proof_1A.jpg', '/api/approve/estimate/tok/proof/p1?download=1'],
    ]);
    expect(calls).toContainEqual(['eq', 'estimate_id', 'est1']);
  });

  it('is just the PDF when nothing was pinned', async () => {
    const { service, calls } = fakeService([]);
    const list = await loadApprovalDownloads(service, { id: 'e', estimate_number: 'EST-1', approval_file_ids: null }, [], '', 't');
    expect(list).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});

describe('attachmentDisposition', () => {
  it('keeps the filename, with an ASCII fallback and a UTF-8 form', () => {
    expect(attachmentDisposition('Estimate EST-2610-014.pdf'))
      .toBe('attachment; filename="Estimate EST-2610-014.pdf"; filename*=UTF-8\'\'Estimate%20EST-2610-014.pdf');
    expect(attachmentDisposition('Déjà "vu"\r\n.png')).toMatch(/^attachment; filename="D_j_ _vu_ \.png"; filename\*=UTF-8''D%C3%A9j%C3%A0%20%22vu%22%20.png$/);
  });
});

describe('download link life', () => {
  it('a pre-424 link downloads for a year from its 30-day send', async () => {
    const { legacyDownloadUntil, DOWNLOAD_LINK_DAYS } = await import('./estimate-approval-downloads');
    const expires = '2026-11-20T00:00:00.000Z';
    const until = legacyDownloadUntil(expires)!;
    expect((until.getTime() - new Date(expires).getTime()) / 86_400_000).toBe(DOWNLOAD_LINK_DAYS - 30);
    expect(legacyDownloadUntil(null)).toBeNull();
    expect(legacyDownloadUntil('nonsense')).toBeNull();
  });

  it('a new send downloads for DOWNLOAD_LINK_DAYS', async () => {
    const { downloadLinkExpiry, DOWNLOAD_LINK_DAYS } = await import('./estimate-approval-downloads');
    const from = new Date('2026-10-22T00:00:00.000Z');
    expect(new Date(downloadLinkExpiry(from)).getTime() - from.getTime()).toBe(DOWNLOAD_LINK_DAYS * 86_400_000);
  });
});

describe('resolveDownloadToken', () => {
  // A tiny two-table fake: estimate_download_tokens by token, estimates by
  // id or approval_token.
  function db(tokens: any[], estimates: any[]) {
    return {
      from(table: string) {
        const filters: [string, any][] = [];
        const q: any = {
          select: () => q,
          eq: (col: string, v: any) => { filters.push([col, v]); return q; },
          maybeSingle: async () => {
            const rows = table === 'estimate_download_tokens' ? tokens : estimates;
            return { data: rows.find(r => filters.every(([c, v]) => r[c] === v)) || null, error: null };
          },
        };
        return q;
      },
    } as any;
  }
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  it('a recorded send serves its own files, after a resend rotated the approval token', async () => {
    const { resolveDownloadToken } = await import('./estimate-approval-downloads');
    const r = await resolveDownloadToken(
      db([{ token: 'old', estimate_id: 'e1', file_ids: ['f1'], expires_at: future }], [{ id: 'e1', approval_token: 'new', approval_file_ids: ['f2'] }]),
      'old', '',
    );
    expect(r).toMatchObject({ ok: true, estimate: { id: 'e1' }, fileIds: ['f1'] });
  });

  it('a recorded send past its year is gone', async () => {
    const { resolveDownloadToken } = await import('./estimate-approval-downloads');
    const r = await resolveDownloadToken(db([{ token: 't', estimate_id: 'e1', file_ids: [], expires_at: past }], [{ id: 'e1' }]), 't', '');
    expect(r).toEqual({ ok: false, status: 410 });
  });

  it('an older link still works after its approval link expired', async () => {
    const { resolveDownloadToken } = await import('./estimate-approval-downloads');
    const r = await resolveDownloadToken(db([], [{ id: 'e1', approval_token: 't', approval_token_expires_at: past, approval_file_ids: ['f1'] }]), 't', '');
    expect(r).toMatchObject({ ok: true, fileIds: ['f1'] });
  });

  it('an unknown token is not found', async () => {
    const { resolveDownloadToken } = await import('./estimate-approval-downloads');
    expect(await resolveDownloadToken(db([], []), 'nope', '')).toEqual({ ok: false, status: 404 });
  });
});
