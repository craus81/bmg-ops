import { describe, it, expect } from 'vitest';
import { closeRefusal, comparedMonths, differs, monthRows, reopenRefusal, type MonthCompared, type PeriodRow } from './months';

const JAN = '2027-01-01';
const FEB = '2027-02-01';
const MAR = '2027-03-01';
const LIVE = '2027-01-01';

const MATCHES: MonthCompared = { status: 'matches', differing: 0, notPosted: false };
const DIFFERS: MonthCompared = { status: 'differs', differing: 2, notPosted: false };

/** Made-up months: January closed by Craig, February closed and reopened since, March not yet posted to. */
const periods = (over: Partial<Record<string, Partial<PeriodRow>>> = {}): PeriodRow[] => [
  {
    id: 'p1', month: JAN, closed: true, closedAt: '2027-02-12T21:04:00Z', closedBy: 'Craig',
    events: [{ action: 'closed', by: 'Craig', reason: null, at: '2027-02-12T21:04:00Z' }],
    ...over[JAN],
  },
  {
    id: 'p2', month: FEB, closed: false, closedAt: null, closedBy: null,
    events: [
      { action: 'closed', by: 'Craig', reason: null, at: '2027-03-09T15:00:00Z' },
      { action: 'reopened', by: 'Harold', reason: 'A late Grimco bill', at: '2027-03-10T14:30:00Z' },
    ],
    ...over[FEB],
  },
];

const rows = (opts: { today?: string; liveFrom?: string | null; periods?: PeriodRow[]; compared?: Map<string, MonthCompared> } = {}) => monthRows({
  liveFrom: opts.liveFrom === undefined ? LIVE : opts.liveFrom,
  today: opts.today ?? '2027-03-15',
  periods: opts.periods ?? periods(),
  compared: opts.compared ?? new Map([[JAN, MATCHES], [FEB, DIFFERS]]),
});

describe('monthRows', () => {
  it('lists the months since the books went live, newest first, with what can be done with each', () => {
    expect(rows()).toEqual([
      { month: MAR, over: false, closed: null, compared: { status: 'none', differing: 0, notPosted: false }, events: [], can: null },
      { month: FEB, over: true, closed: null, compared: DIFFERS, events: periods()[1].events, can: 'close' },
      { month: JAN, over: true, closed: { at: '2027-02-12T21:04:00Z', by: 'Craig' }, compared: MATCHES, events: periods()[0].events, can: 'reopen' },
    ]);
  });

  it('offers only the first open month to close, once it is over, and only the latest closed one to reopen', () => {
    const open = periods({ [JAN]: { closed: false, closedAt: null, closedBy: null } });
    expect(rows({ periods: open }).map((r) => [r.month, r.can])).toEqual([[MAR, null], [FEB, null], [JAN, 'close']]);
    // March is over on April 1, Central time, but not on March 31.
    expect(rows({ today: '2027-03-31' })[0]).toMatchObject({ month: MAR, over: false, can: null });
    expect(rows({ today: '2027-04-01' }).map((r) => [r.month, r.over, r.can]))
      .toEqual([['2027-04-01', false, null], [MAR, true, null], [FEB, true, 'close'], [JAN, true, 'reopen']]);
    const both = periods({ [FEB]: { closed: true, closedAt: '2027-03-11T10:00:00Z', closedBy: 'Craig' } });
    expect(rows({ periods: both }).map((r) => [r.month, r.can])).toEqual([[MAR, null], [FEB, 'reopen'], [JAN, null]]);
  });

  it('has nothing before the books are live, nor before the month they go live', () => {
    expect(rows({ liveFrom: null })).toEqual([]);
    expect(rows({ today: '2026-12-20' })).toEqual([]);
    expect(rows({ today: '2027-01-31', periods: [] }).map((r) => [r.month, r.over, r.can])).toEqual([[JAN, false, null]]);
  });
});

describe('closeRefusal', () => {
  const open = rows({ periods: periods({ [JAN]: { closed: false, closedAt: null, closedBy: null } }) });
  const refusal = (month: string, opts: { reason?: string; liveFrom?: string | null; rows?: ReturnType<typeof rows> } = {}) => closeRefusal({
    name: 'BMG Fleet Installations',
    liveFrom: opts.liveFrom === undefined ? LIVE : opts.liveFrom,
    rows: opts.rows ?? open,
    month,
    reason: opts.reason ?? '',
  });

  it('closes the first open month once it is over', () => {
    expect(refusal(JAN)).toBeNull();
  });

  it('refuses before the books are live, before the month they went live, and a month not over', () => {
    expect(refusal(JAN, { liveFrom: null, rows: [] })).toEqual({
      message: "BMG Fleet Installations's books aren't live yet, so there's no month to close.", status: 409,
    });
    expect(refusal('2026-12-01')).toEqual({
      message: "December 2026 is before BMG Fleet Installations's books went live, so nothing posts to it but the opening entry.", status: 400,
    });
    expect(refusal(MAR)).toEqual({ message: "March 2027 isn't over yet.", status: 409 });
    expect(refusal('2027-06-01')).toEqual({ message: "June 2027 isn't over yet.", status: 409 });
  });

  it('closes months in order, and each once', () => {
    expect(refusal(FEB, { reason: 'Checked' })).toEqual({ message: 'Close January 2027 first: months close in order.', status: 409 });
    expect(refusal(JAN, { rows: rows() })).toEqual({ message: 'January 2027 is already closed.', status: 409 });
  });

  it("needs a reason to close a month that doesn't match NetSuite whole", () => {
    const februaryNext = rows();
    expect(refusal(FEB, { rows: februaryNext })).toEqual({ message: "February 2027 doesn't match NetSuite, so say why it's closed anyway.", status: 400 });
    expect(refusal(FEB, { rows: februaryNext, reason: '   ' })).not.toBeNull();
    expect(refusal(FEB, { rows: februaryNext, reason: 'The CPA moved it in NetSuite in March' })).toBeNull();
    const notPosted = rows({ compared: new Map([[JAN, MATCHES], [FEB, { ...MATCHES, notPosted: true }]]) });
    expect(refusal(FEB, { rows: notPosted })?.status).toBe(400);
  });
});

describe('reopenRefusal', () => {
  const both = rows({ periods: periods({ [FEB]: { closed: true, closedAt: '2027-03-11T10:00:00Z', closedBy: 'Craig' } }) });

  it('reopens the latest closed month, for a reason', () => {
    expect(reopenRefusal({ rows: both, month: FEB, reason: 'A late Grimco bill' })).toBeNull();
    expect(reopenRefusal({ rows: both, month: FEB, reason: ' ' })).toEqual({ message: 'Say why February 2027 is reopened.', status: 400 });
  });

  it('reopens from the latest, and only a closed month', () => {
    expect(reopenRefusal({ rows: both, month: JAN, reason: 'A late bill' })).toEqual({
      message: 'Reopen February 2027 first: months reopen from the latest.', status: 409,
    });
    expect(reopenRefusal({ rows: rows(), month: FEB, reason: 'A late bill' })).toEqual({ message: "February 2027 isn't closed.", status: 409 });
    expect(reopenRefusal({ rows: rows(), month: MAR, reason: 'A late bill' })).toEqual({ message: "March 2027 isn't closed.", status: 409 });
  });
});

describe('comparedMonths', () => {
  it("compares each month as Differences vs NetSuite does, and says when NetSuite has kinds FleetSuite doesn't post", () => {
    const compared = comparedMonths({
      netsuite: [
        { month: JAN, account: '120', kind: 'CustInvc', net: '100.00' },
        { month: JAN, account: '400', kind: 'CustInvc', net: '-100.00' },
        { month: FEB, account: '120', kind: 'CustInvc', net: '50.00' },
        { month: FEB, account: '400', kind: 'CustInvc', net: '-50.00' },
        { month: MAR, account: '120', kind: 'CustInvc', net: '80.00' },
        { month: MAR, account: '400', kind: 'CustInvc', net: '-80.00' },
        { month: MAR, account: '600', kind: 'ExpRept', net: '30.00' },
        { month: MAR, account: '200', kind: 'ExpRept', net: '-30.00' },
      ],
      fleetsuite: [
        { month: JAN, account: '120', kind: 'invoice', net: '100.00' },
        { month: JAN, account: '400', kind: 'invoice', net: '-100.00' },
        { month: FEB, account: '120', kind: 'invoice', net: '40.00' },
        { month: FEB, account: '400', kind: 'invoice', net: '-40.00' },
        { month: MAR, account: '120', kind: 'invoice', net: '80.00' },
        { month: MAR, account: '400', kind: 'invoice', net: '-80.00' },
      ],
      netsuite_kinds: [
        { month: JAN, kind: 'CustInvc', documents: 1, moved: '100.00' },
        { month: FEB, kind: 'CustInvc', documents: 1, moved: '50.00' },
        { month: MAR, kind: 'CustInvc', documents: 1, moved: '80.00' },
        { month: MAR, kind: 'ExpRept', documents: 1, moved: '30.00' },
      ],
      fleetsuite_kinds: [
        { month: JAN, kind: 'invoice', documents: 1, moved: '100.00' },
        { month: FEB, kind: 'invoice', documents: 1, moved: '40.00' },
        { month: MAR, kind: 'invoice', documents: 1, moved: '80.00' },
      ],
    });
    expect(Object.fromEntries(compared)).toEqual({
      [JAN]: MATCHES,
      [FEB]: DIFFERS,
      [MAR]: { status: 'matches', differing: 0, notPosted: true },
    });
    expect([...compared.values()].map(differs)).toEqual([false, true, true]);
  });

  it('counts every kind FleetSuite posts, even one it has posted none of yet, and has nothing unposted in a month NetSuite moved nothing in', () => {
    const compared = comparedMonths({
      netsuite: [
        { month: JAN, account: '600', kind: 'VendBill', net: '25.00' },
        { month: JAN, account: '200', kind: 'VendBill', net: '-25.00' },
      ],
      fleetsuite: [
        { month: FEB, account: '120', kind: 'invoice', net: '60.00' },
        { month: FEB, account: '400', kind: 'invoice', net: '-60.00' },
      ],
      netsuite_kinds: [{ month: JAN, kind: 'VendBill', documents: 1, moved: '25.00' }],
      fleetsuite_kinds: [{ month: FEB, kind: 'invoice', documents: 1, moved: '60.00' }],
    });
    // January's bill is one FleetSuite should have posted, so the month differs; February's invoice is FleetSuite's alone.
    expect(Object.fromEntries(compared)).toEqual({
      [JAN]: { status: 'differs', differing: 2, notPosted: false },
      [FEB]: { status: 'differs', differing: 2, notPosted: false },
    });
  });
});
