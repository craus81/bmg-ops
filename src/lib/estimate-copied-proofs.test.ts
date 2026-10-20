import { describe, it, expect } from 'vitest';
import { sanitizeCopiedProofs, proofsForCopy } from './estimate-copied-proofs';

describe('sanitizeCopiedProofs', () => {
  it('keeps one entry per job with files, and drops junk', () => {
    expect(sanitizeCopiedProofs([
      { job_id: 'j1', file_ids: ['a', 'a', 'b'], from_estimate: 'EST-1' },
      { job_id: 'j1', file_ids: ['c'] },
      { job_id: 'j2', file_ids: [] },
      { file_ids: ['x'] },
      'nope',
    ])).toEqual([{ job_id: 'j1', file_ids: ['a', 'b'], from_estimate: 'EST-1' }]);
    expect(sanitizeCopiedProofs(null)).toEqual([]);
  });
});

describe('proofsForCopy', () => {
  const jobs = [
    { id: 'own', estimate_attach: { file_ids: ['f1'] } },
    { id: 'none', estimate_attach: null },
  ];
  it('shows the chosen files of the original\'s jobs, then what the original itself showed', () => {
    expect(proofsForCopy(jobs, [{ job_id: 'older', file_ids: ['f9'], from_estimate: 'EST-0' }], 'EST-1', new Set())).toEqual([
      { job_id: 'own', file_ids: ['f1'], from_estimate: 'EST-1' },
      { job_id: 'older', file_ids: ['f9'], from_estimate: 'EST-0' },
    ]);
  });
  it('leaves out jobs that move to a revision', () => {
    expect(proofsForCopy(jobs, null, 'EST-1', new Set(['own']))).toEqual([]);
  });
});
