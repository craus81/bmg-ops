import { describe, it, expect } from 'vitest';
import { computePnl, type PnlInput } from './cni-pnl';

const base = (over: Partial<PnlInput> = {}): PnlInput => ({
  budget: 10_000,
  payoutMode: 'company',
  vinsTotal: 10,
  vinsCompleted: 10,
  revenue: { amount: 20_000, vinsCounted: 10, vinsMissing: 0 },
  installerCost: { approved: 8_000, pending: 0, unpricedCredits: 0 },
  ...over,
});

describe('computePnl', () => {
  it('subtracts committed installer cost from known revenue', () => {
    const p = computePnl(base());
    expect(p.marginBeforeMaterials).toBe(12_000);
    expect(p.marginPct).toBe(60);
  });

  it('divides per vehicle by the right denominators', () => {
    const p = computePnl(base());
    expect(p.perVehicle.revenue).toBe(2_000);
    expect(p.perVehicle.installerCost).toBe(800);
    expect(p.perVehicle.margin).toBe(1_200);
  });

  it('reports a vehicle with no billed amount as MISSING, never as zero revenue', () => {
    const p = computePnl(base({
      revenue: { amount: 16_000, vinsCounted: 8, vinsMissing: 2 },
    }));
    // Per-vehicle revenue divides by the eight we can see, not by ten — the
    // two unknowns would drag the average down to a number that is simply wrong.
    expect(p.perVehicle.revenue).toBe(2_000);
    expect(p.caveats.some(c => /no billed amount on file/.test(c))).toBe(true);
    expect(p.caveats.some(c => /a floor, not a total/.test(c))).toBe(true);
  });

  it('returns a null margin when NO revenue is known at all', () => {
    const p = computePnl(base({
      revenue: { amount: 0, vinsCounted: 0, vinsMissing: 10 },
    }));
    expect(p.marginBeforeMaterials).toBeNull();
    expect(p.marginPct).toBeNull();
    expect(p.perVehicle.revenue).toBeNull();
    expect(p.perVehicle.margin).toBeNull();
  });

  it('never divides by zero vehicles', () => {
    const p = computePnl(base({
      vinsCompleted: 0,
      revenue: { amount: 0, vinsCounted: 0, vinsMissing: 0 },
    }));
    expect(p.perVehicle.installerCost).toBeNull();
    expect(p.perVehicle.revenue).toBeNull();
  });

  it('ALWAYS says the margin is before materials', () => {
    // cni_jobs.material_delivered is a boolean, not an amount: nothing in
    // this app costs materials against a CNI job, and calling the result
    // plain "margin" would overstate every job by the vinyl on it.
    for (const input of [base(), base({ budget: null }), base({ payoutMode: 'individual' })]) {
      expect(computePnl(input).caveats.some(c => /Materials and shipping are not costed/.test(c))).toBe(true);
    }
  });

  it('keeps PENDING vendor invoices out of margin and budget, and says so', () => {
    const p = computePnl(base({
      installerCost: { approved: 8_000, pending: 3_000, unpricedCredits: 0 },
    }));
    expect(p.marginBeforeMaterials).toBe(12_000);   // pending is not subtracted
    expect(p.overBudget).toBe(false);               // 8k against a 10k budget
    expect(p.caveats.some(c => /not approved/.test(c))).toBe(true);
  });

  it('goes over budget on committed cost only', () => {
    expect(computePnl(base({ installerCost: { approved: 10_001, pending: 0, unpricedCredits: 0 } })).overBudget).toBe(true);
    expect(computePnl(base({ installerCost: { approved: 10_000, pending: 0, unpricedCredits: 0 } })).overBudget).toBe(false);
  });

  it('has no budget opinion at all when no budget is set', () => {
    const p = computePnl(base({ budget: null, installerCost: { approved: 99_999, pending: 0, unpricedCredits: 0 } }));
    expect(p.budgetPct).toBeNull();
    expect(p.overBudget).toBe(false);
  });

  it('treats a zero budget as no budget rather than instantly over', () => {
    const p = computePnl(base({ budget: 0 }));
    expect(p.budgetPct).toBeNull();
    expect(p.overBudget).toBe(false);
  });

  it('counts unpriced credits instead of summing them as nothing', () => {
    const p = computePnl(base({
      payoutMode: 'individual',
      installerCost: { approved: 5_000, pending: 0, unpricedCredits: 3 },
    }));
    expect(p.installerCost.approved).toBe(5_000);
    expect(p.caveats.some(c => /3 pay credits have no rate set yet/.test(c))).toBe(true);
  });

  it('reports budget usage as a percentage of committed cost', () => {
    expect(computePnl(base({ installerCost: { approved: 2_500, pending: 0, unpricedCredits: 0 } })).budgetPct).toBe(25);
  });

  it('gives a null margin percentage on zero revenue rather than 0%', () => {
    const p = computePnl(base({
      revenue: { amount: 0, vinsCounted: 3, vinsMissing: 0 },
      installerCost: { approved: 500, pending: 0, unpricedCredits: 0 },
    }));
    // A percentage of nothing is not 0% — the loss is real and the ratio is
    // undefined.
    expect(p.marginBeforeMaterials).toBe(-500);
    expect(p.marginPct).toBeNull();
  });
});
