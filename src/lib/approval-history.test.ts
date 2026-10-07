import { describe, it, expect } from 'vitest';
import { buildApprovalHistory, dropDuplicateThreadCopies, historySummary, type HistoryMessage, type RoundRow } from './approval-history';

const msg = (over: Partial<HistoryMessage>): HistoryMessage => ({
  id: Math.random().toString(36).slice(2),
  source: 'email_log', channel: 'email', direction: 'out', at: '2026-10-01T12:00:00Z',
  kind: 'proof_approval', subject: null, body: null, who: 'a@b.com', sentByName: null,
  status: 'delivered', detail: null, reminder: false, ...over,
});

const rounds: RoundRow[] = [
  { round_number: 1, addressing: null, proof_file_id: 'f1', sent_at: '2026-10-01T12:00:00Z', sent_by: 'u1', outcome: 'rejected', decided_at: '2026-10-02T09:00:00Z', rejection_reason: 'Logo bigger' },
  { round_number: 2, addressing: 'Logo bigger', proof_file_id: 'f2', sent_at: '2026-10-03T12:00:00Z', sent_by: 'u1', outcome: 'pending', decided_at: null, rejection_reason: null },
];

describe('buildApprovalHistory', () => {
  it('files proof messages under the round open when they went, newest round first', () => {
    const h = buildApprovalHistory(
      rounds,
      [
        msg({ id: 'e1', at: '2026-10-01T12:00:02Z' }),
        msg({ id: 'r1', at: '2026-10-02T08:00:00Z', reminder: true }),
        msg({ id: 'e2', at: '2026-10-03T12:00:01Z' }),
        msg({ id: 't2', source: 'sms_log', channel: 'text', at: '2026-10-03T12:00:03Z', status: 'skipped' }),
      ],
      { u1: 'Brian' },
      { f1: 'wrap.pdf' },
      null,
    );
    expect(h.rounds.map(r => r.label)).toEqual(['Revision 1', 'First proof']);
    expect(h.rounds[1].messages.map(m => m.id)).toEqual(['e1', 'r1']);
    expect(h.rounds[0].messages.map(m => m.id)).toEqual(['e2', 't2']);
    expect(h.rounds[1].proofFileName).toBe('wrap.pdf');
    expect(h.rounds[1].sentByName).toBe('Brian');
    expect(h.other).toEqual([]);
  });

  it('keeps pickup notices and pre-round messages out of the rounds', () => {
    const h = buildApprovalHistory(
      rounds,
      [
        msg({ id: 'old', at: '2026-09-01T00:00:00Z' }),
        msg({ id: 'pick', kind: 'pickup_notice', at: '2026-10-05T00:00:00Z' }),
      ],
      {}, {}, null,
    );
    expect(h.other.map(m => m.id)).toEqual(['old', 'pick']);
  });

  it('files customer thread replies by time', () => {
    const h = buildApprovalHistory(rounds, [msg({ id: 'in', source: 'thread', kind: null, direction: 'in', channel: 'text', at: '2026-10-01T15:00:00Z' })], {}, {}, null);
    expect(h.rounds[1].messages.map(m => m.id)).toEqual(['in']);
  });
});

describe('dropDuplicateThreadCopies', () => {
  it('drops an outbound thread copy of a logged send on the same channel, keeps replies', () => {
    const logged = [msg({ kind: 'pickup_notice', at: '2026-10-05T10:00:00Z' })];
    const thread = [
      msg({ id: 'copy', source: 'thread', kind: null, at: '2026-10-05T10:00:01Z' }),
      msg({ id: 'text', source: 'thread', kind: null, channel: 'text', at: '2026-10-05T10:00:01Z' }),
      msg({ id: 'reply', source: 'thread', kind: null, direction: 'in', at: '2026-10-05T10:00:30Z' }),
    ];
    expect(dropDuplicateThreadCopies(logged, thread).map(m => m.id)).toEqual(['text', 'reply']);
  });
});

describe('historySummary', () => {
  it('names the latest round, change requests and message count', () => {
    const h = buildApprovalHistory(rounds, [msg({ at: '2026-10-01T12:00:02Z' }), msg({ at: '2026-10-03T12:00:02Z' })], {}, {}, null);
    expect(historySummary(h)).toBe('Revision 1 · 1 change request · 2 messages');
  });
});
