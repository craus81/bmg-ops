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
