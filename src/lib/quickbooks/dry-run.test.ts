import { describe, it, expect } from 'vitest';
import { DRY_RUN_ROW_CAP, buildMatchReport, estimatePlan, type GradedParty } from './dry-run';
import type { CustomerIndexRow, MatchGrade } from './customer-match';

const customer = (id: string): CustomerIndexRow => ({
  id, netsuite_id: `ns-${id}`, company_name: `Co ${id}`, entity_id: null, email: null, phone_digits: null,
});

const party = (n: number, over: Partial<GradedParty> = {}): GradedParty => ({
  externalId: `Customer/${n}`,
  displayName: `Company ${n}`,
  cleanedName: `Company ${n}`,
  ...over,
});

describe('buildMatchReport — the four buckets are the gate', () => {
  it('sorts each grade into its bucket and carries the evidence', () => {
    const parties = [party(1), party(2), party(3), party(4), party(5, { alreadyManual: true })];
    const grades: (MatchGrade | null)[] = [
      { status: 'exact', customer: customer('a'), reason: 'company name matches' },
      { status: 'cleaned', customer: customer('b'), reason: 'company name matches after cleanup' },
      { status: 'ambiguous', candidates: [customer('c'), customer('d')], reason: 'two hits' },
      { status: 'unmatched' },
      null,
    ];
    const report = buildMatchReport(parties, grades);
    expect(report.buckets).toEqual({ exact: 1, cleaned: 1, ambiguous: 1, unmatched: 1, alreadyManual: 1 });
    expect(report.total).toBe(5);
    expect(report.rows[0].matched).toEqual({ customerId: 'a', companyName: 'Co a', netsuiteId: 'ns-a' });
    expect(report.rows[2].candidates.map(c => c.customerId)).toEqual(['c', 'd']);
    expect(report.rows[3].matched).toBeNull();
  });

  it('the buckets ALWAYS sum to the total across a multi-page, multi-invocation walk', () => {
    // Owner requirement 7 makes these counts the thing being approved, so
    // they are full coverage — chunked across invocations, never a sample.
    let report = buildMatchReport([party(1)], [{ status: 'exact', customer: customer('a'), reason: 'r' }]);
    report = buildMatchReport([party(2)], [{ status: 'unmatched' }], report);
    report = buildMatchReport([party(3)], [{ status: 'ambiguous', candidates: [customer('c')], reason: 'r' }], report);
    const sum = Object.values(report.buckets).reduce((a, b) => a + b, 0);
    expect(sum).toBe(report.total);
    expect(report.total).toBe(3);
    expect(report.rows).toHaveLength(3);
  });

  it('truncated caps only the ROW LIST — a bucket count is never capped', () => {
    const parties = Array.from({ length: DRY_RUN_ROW_CAP + 25 }, (_, i) => party(i));
    const grades = parties.map(() => ({ status: 'unmatched' }) as MatchGrade);
    const report = buildMatchReport(parties, grades);
    expect(report.rows).toHaveLength(DRY_RUN_ROW_CAP);
    expect(report.truncated).toBe(25);
    expect(report.buckets.unmatched).toBe(DRY_RUN_ROW_CAP + 25);
    expect(report.total).toBe(DRY_RUN_ROW_CAP + 25);
  });

  // The PRODUCER of `alreadyManual` is importer.ts's phaseDryRunCustomers,
  // which reads each page's stored match_status before grading — covered
  // end to end by importer.test.ts's "files a row a HUMAN already decided
  // under alreadyManual". This case is the fold, not the flag.
  it('an already-decided row is counted separately and never re-graded', () => {
    const report = buildMatchReport([party(1, { alreadyManual: true })], [{ status: 'exact', customer: customer('a'), reason: 'r' }]);
    expect(report.buckets.alreadyManual).toBe(1);
    expect(report.buckets.exact).toBe(0);
    expect(report.rows[0].matched).toBeNull();
  });

  it('an empty page leaves a previous report untouched', () => {
    const first = buildMatchReport([party(1)], [{ status: 'exact', customer: customer('a'), reason: 'r' }]);
    const second = buildMatchReport([], [], first);
    expect(second.total).toBe(1);
    expect(second.rows).toHaveLength(1);
  });
});

describe('estimatePlan', () => {
  it('scales the estimate with the counts and names the phases', () => {
    const plan = estimatePlan({ Invoice: 4000, Payment: 3000, Customer: 2000 }, ['connect', 'transactions'], 300);
    expect(plan.phases).toEqual(['connect', 'transactions']);
    expect(plan.estimatedApiCalls).toBeGreaterThan(35);
    expect(plan.estimatedInvocationsAt240s).toBeGreaterThanOrEqual(1);
    expect(plan.reportRows).toBe(300);
  });

  it('a null count (COUNT(*) unsupported) contributes nothing rather than NaN', () => {
    const plan = estimatePlan({ Invoice: null, Customer: null }, ['connect'], 0);
    expect(Number.isFinite(plan.estimatedApiCalls)).toBe(true);
    expect(plan.estimatedInvocationsAt240s).toBe(1);
  });

  it('only counts PDF calls when the pdfs phase is actually running', () => {
    const without = estimatePlan({ Invoice: 5000 }, ['transactions'], 0);
    const with_ = estimatePlan({ Invoice: 5000 }, ['transactions', 'pdfs'], 0);
    expect(with_.estimatedApiCalls - without.estimatedApiCalls).toBe(5000);
  });
});
