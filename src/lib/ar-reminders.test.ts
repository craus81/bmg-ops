import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { OpenArInvoice } from '@/lib/financials-data';
import { stepFor, newCrossings, groupPastDue, buildArDigest, normalizeSteps, resolveArSettings } from '@/lib/ar-reminders';
import { mergePdfs, mapWithConcurrency } from '@/lib/pdf-merge';

const STEPS = [1, 15, 30, 60];

function inv(id: string, days: number, opts: Partial<OpenArInvoice> = {}): OpenArInvoice {
  return {
    id, tranid: `INV${id}`, date: '2026-08-01', dueDate: '2026-09-01', po: null,
    customer: opts.customer ?? 'Masterack', entityId: opts.entityId ?? '100',
    total: 100, unpaid: opts.unpaid ?? 100, daysPastDue: days, bucket: 'd1_30', nsUrl: '#',
    ...opts,
  };
}

describe('stepFor', () => {
  it('returns the highest step reached', () => {
    expect(stepFor(0, STEPS)).toBeNull();
    expect(stepFor(1, STEPS)).toBe(1);
    expect(stepFor(14, STEPS)).toBe(1);
    expect(stepFor(15, STEPS)).toBe(15);
    expect(stepFor(45, STEPS)).toBe(30);
    expect(stepFor(400, STEPS)).toBe(60);
  });
});

describe('newCrossings', () => {
  it('alerts an invoice once per step', () => {
    const invoices = [inv('1', 1), inv('2', 16)];
    const first = newCrossings(invoices, STEPS, new Set());
    expect(first.map(c => [c.invoice.id, c.step])).toEqual([['1', 1], ['2', 15]]);
    const alerted = new Set(first.map(c => `${c.invoice.id}:${c.step}`));
    expect(newCrossings(invoices, STEPS, alerted)).toEqual([]);
    // A day later invoice 1 is still at step 1 — nothing new.
    expect(newCrossings([inv('1', 2)], STEPS, alerted)).toEqual([]);
    // Two weeks later it reaches 15.
    expect(newCrossings([inv('1', 15)], STEPS, alerted).map(c => c.step)).toEqual([15]);
  });

  it('first sight of a 40-day invoice alerts once, at 30', () => {
    expect(newCrossings([inv('1', 40)], STEPS, new Set()).map(c => c.step)).toEqual([30]);
  });

  it('stays quiet when the due date moved back below a step already alerted', () => {
    expect(newCrossings([inv('1', 20)], STEPS, new Set(['1:30']))).toEqual([]);
  });

  it('skips current and zero-balance invoices', () => {
    expect(newCrossings([inv('1', 0), inv('2', 20, { unpaid: 0 })], STEPS, new Set())).toEqual([]);
  });
});

describe('groupPastDue + digest', () => {
  it('groups by customer, most money first', () => {
    const g = groupPastDue([
      inv('1', 5, { unpaid: 50 }),
      inv('2', 40, { unpaid: 500, customer: 'Bodewell', entityId: '200' }),
      inv('3', 70, { unpaid: 60 }),
      inv('4', 0, { unpaid: 999 }),
    ]);
    expect(g.map(c => [c.customer, c.pastDue, c.oldestDays, c.invoices.length])).toEqual([
      ['Bodewell', 500, 40, 1],
      ['Masterack', 110, 70, 2],
    ]);
  });

  it('builds a digest naming customers and the whole book', () => {
    const invoices = [inv('1', 15), inv('2', 60, { customer: 'Bodewell', entityId: '200', unpaid: 250 })];
    const d = buildArDigest(newCrossings(invoices, STEPS, new Set()), groupPastDue(invoices));
    expect(d.title).toBe('💵 2 invoices hit a past-due mark today');
    expect(d.body).toContain('Bodewell: 1 invoice hit 60 days past due');
    expect(d.body).toContain('Masterack: 1 invoice hit 15 days past due');
    expect(d.body).toContain('Total past due: $350.00 on 2 invoices from 2 customers.');
  });
});

describe('settings', () => {
  it('cleans step lists and falls back to the defaults', () => {
    expect(normalizeSteps(['30', 1, 1, -4, 'x', 15])).toEqual([1, 15, 30]);
    expect(normalizeSteps([])).toEqual(STEPS);
    expect(resolveArSettings(null)).toEqual({ enabled: true, stepDays: STEPS, recipientIds: [] });
  });
});

describe('pdf-merge', () => {
  it('merges pages in order', async () => {
    const make = async (pages: number) => {
      const d = await PDFDocument.create();
      for (let i = 0; i < pages; i++) d.addPage();
      return Buffer.from(await d.save());
    };
    const merged = await mergePdfs([await make(2), await make(3)]);
    expect((await PDFDocument.load(merged)).getPageCount()).toBe(5);
  });

  it('keeps order and caps concurrency', async () => {
    let inFlight = 0, peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async n => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});
