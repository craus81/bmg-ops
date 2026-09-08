import { describe, it, expect } from 'vitest';
import {
  roundLabel, nextRoundNumber, addressingFor, summarizeRounds, roundChip,
  customerRevisionStats, type ProofRound, type JobRoundCount,
} from './proof-rounds';

const round = (n: number, over: Partial<ProofRound> = {}): ProofRound => ({
  round_number: n, outcome: 'pending', ...over,
});

describe('roundLabel', () => {
  it('calls the first proof a proof, not a revision', () => {
    expect(roundLabel(1)).toBe('First proof');
    expect(roundLabel(2)).toBe('Revision 1');
    expect(roundLabel(4)).toBe('Revision 3');
  });
});

describe('nextRoundNumber', () => {
  it('starts at 1 and climbs from the highest so far', () => {
    expect(nextRoundNumber([])).toBe(1);
    expect(nextRoundNumber([round(1), round(2)])).toBe(3);
  });

  it('is not fooled by rounds arriving out of order', () => {
    expect(nextRoundNumber([round(3), round(1), round(2)])).toBe(4);
  });
});

describe('addressingFor', () => {
  it('carries the most recent rejection reason forward', () => {
    const rounds = [
      round(1, { outcome: 'rejected', rejection_reason: 'Logo too small' }),
      round(2, { outcome: 'rejected', rejection_reason: 'Wrong shade of blue' }),
    ];
    expect(addressingFor(rounds)).toBe('Wrong shade of blue');
  });

  it('is null on a first proof', () => {
    expect(addressingFor([])).toBeNull();
  });

  it('is null when the last round was abandoned rather than rejected', () => {
    // A superseded round asked for nothing — nobody rejected it.
    expect(addressingFor([round(1, { outcome: 'superseded' })])).toBeNull();
  });

  it('ignores a rejection with an empty reason', () => {
    expect(addressingFor([round(1, { outcome: 'rejected', rejection_reason: '   ' })])).toBeNull();
  });
});

describe('summarizeRounds / roundChip', () => {
  it('counts outcomes and reports the open round’s ask', () => {
    const s = summarizeRounds([
      round(1, { outcome: 'rejected', rejection_reason: 'Logo too small' }),
      round(2, { outcome: 'pending', addressing: 'Logo too small' }),
    ]);
    expect(s).toMatchObject({ total: 2, rejected: 1, pending: 1, current: 2, hasRevisions: true });
    expect(s.addressing).toBe('Logo too small');
  });

  it('shows no chip on a first proof — every job has one', () => {
    expect(roundChip(summarizeRounds([round(1)]))).toBeNull();
    expect(roundChip(summarizeRounds([]))).toBeNull();
  });

  it('warns at three rounds and flags at four', () => {
    expect(roundChip(summarizeRounds([round(1), round(2)]))!.tone).toBe('none');
    expect(roundChip(summarizeRounds([round(1), round(2), round(3)]))!.tone).toBe('warn');
    const bad = roundChip(summarizeRounds([round(1), round(2), round(3), round(4)]))!;
    expect(bad.tone).toBe('bad');
    expect(bad.text).toBe('R4');
  });
});

describe('customerRevisionStats', () => {
  const job = (customer: string, rounds: number, settled = true): JobRoundCount =>
    ({ customerName: customer, rounds, settled });

  it('averages rounds per customer, worst first', () => {
    const { rows } = customerRevisionStats([
      job('Acme', 1), job('Acme', 3),
      job('Globex', 1), job('Globex', 1),
    ]);
    expect(rows[0]).toMatchObject({ customer: 'Acme', jobs: 2, avgRounds: 2, revisedJobs: 1, worstJobRounds: 3 });
    expect(rows[1].customer).toBe('Globex');
  });

  it('excludes jobs still waiting on the customer, and says how many', () => {
    // A job on round 1 with no answer yet might end at 4. Counting it as
    // 1 drags the average down and makes a customer look BETTER the more
    // of their work is currently stuck — precisely backwards.
    const { rows, excludedInFlight } = customerRevisionStats([
      job('Acme', 3), job('Acme', 1, false), job('Acme', 1, false),
    ]);
    expect(excludedInFlight).toBe(2);
    expect(rows[0].jobs).toBe(1);
    expect(rows[0].avgRounds).toBe(3);
  });

  it('buckets jobs with no customer under one honest heading', () => {
    const { rows } = customerRevisionStats([{ customerName: null, rounds: 2, settled: true }]);
    expect(rows[0].customer).toBe('No customer');
  });

  it('returns nothing rather than dividing by zero', () => {
    const { rows, excludedInFlight } = customerRevisionStats([]);
    expect(rows).toEqual([]);
    expect(excludedInFlight).toBe(0);
  });
});
