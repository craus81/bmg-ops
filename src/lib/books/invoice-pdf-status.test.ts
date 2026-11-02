import { describe, it, expect } from 'vitest';
import { PDF_TRIES, pdfStatusLine, type InvoicePdfView, type PdfRow } from './invoice-pdf-status';
import type { OwnCheckStatus } from './own-invoice-check';

// What an invoice's page in Books → Own invoices says about FleetSuite's own
// PDF of it in NetSuite (Books part 68). Times are Central: 21:04Z on
// 2026-11-18 is 3:04 PM. Made-up data.

const NOW = Date.parse('2026-11-18T22:00:00Z');
const ON = '2026-11-01T00:00:00Z';
const DAY = 24 * 3_600_000;

const row = (over: Partial<PdfRow> = {}): PdfRow => ({
  version: 1, state: 'held', held_for: 'differs', file_name: null, file_id: null, replaced_file_id: null, replaced: null,
  tries: 0, error: null, asked_by_name: null, checked_at: '2026-11-18T21:00:00Z', started_at: null, answered_at: null, ...over,
});

const view = (pdfs: PdfRow[], over: { on?: boolean; since?: string | null; version?: number; madeAt?: string } = {}): InvoicePdfView => ({
  on: over.on ?? true,
  since: over.since === undefined ? ON : over.since,
  state: { version: over.version ?? 1, made_at: over.madeAt ?? '2026-11-17T22:00:00Z', pdfs },
});

const line = (v: InvoicePdfView, check: OwnCheckStatus = 'matches', now = NOW) => pdfStatusLine(v, check, now);
const STILL = " NetSuite's invoice still has FleetSuite's PDF from before the invoice was fixed.";

describe('pdfStatusLine', () => {
  it('has nothing to say of an invoice FleetSuite has no copy of', () => {
    expect(line({ on: true, since: ON, state: null })).toEqual({
      text: 'FleetSuite has no copy of this invoice, so it has no PDF of it for NetSuite.', tone: 'muted', canSend: false,
    });
  });

  it('says NetSuite has it, when and who sent it, switched on or off', () => {
    const attached = row({ state: 'attached', held_for: null, file_id: '88001', answered_at: '2026-11-18T21:04:00Z' });
    for (const on of [true, false]) {
      expect(line(view([attached], { on }))).toEqual({
        text: "NetSuite has FleetSuite's PDF of this invoice, attached Nov 18, 3:04 PM.", tone: 'ok', canSend: false,
      });
    }
    expect(line(view([{ ...attached, asked_by_name: 'Craig George' }])).text)
      .toBe("NetSuite has FleetSuite's PDF of this invoice, attached Nov 18, 3:04 PM by Craig George.");
    expect(line(view([{ ...attached, answered_at: null }])).text).toBe("NetSuite has FleetSuite's PDF of this invoice.");
    expect(line(view([{ ...attached, answered_at: 'not a time' }])).text).toBe("NetSuite has FleetSuite's PDF of this invoice.");
  });

  it("warns when NetSuite's invoice has changed since FleetSuite's PDF went on it", () => {
    const attached = row({ state: 'attached', held_for: null, file_id: '88001', answered_at: '2026-11-18T21:04:00Z' });
    for (const check of ['differs', 'incomplete'] as const) {
      expect(line(view([attached]), check)).toEqual({
        text: "NetSuite has FleetSuite's PDF of this invoice, attached Nov 18, 3:04 PM. NetSuite's invoice has changed since, so the PDF may not show what it does now.",
        tone: 'warn',
        canSend: false,
      });
    }
    for (const check of ['waiting', 'voided'] as const) expect(line(view([attached]), check).tone).toBe('ok');
  });

  it("warns when NetSuite couldn't take the PDF from before the fix off the invoice", () => {
    const fixed = row({ version: 2, state: 'attached', held_for: null, file_id: '88002', replaced_file_id: '88001', replaced: false, answered_at: '2026-11-18T21:04:00Z' });
    const earlier = row({ state: 'attached', held_for: null, file_id: '88001', answered_at: '2026-11-10T21:04:00Z' });
    expect(line(view([fixed, earlier], { version: 2 }))).toEqual({
      text: "NetSuite has FleetSuite's PDF of this invoice, attached Nov 18, 3:04 PM. "
        + "NetSuite couldn't take the PDF from before the invoice was fixed off it, so both are on it.",
      tone: 'warn',
      canSend: false,
    });
    expect(line(view([{ ...fixed, replaced: true }, earlier], { version: 2 })).tone).toBe('ok');
    expect(line(view([{ ...fixed, replaced: null }, earlier], { version: 2 })).tone).toBe('ok');
  });

  it("sends nothing while Invoice PDFs is off, whatever it said before", () => {
    const off = { text: 'Invoice PDFs is switched off, so FleetSuite sends no PDF of this invoice to NetSuite.', tone: 'muted', canSend: false };
    expect(line(view([], { on: false }))).toEqual(off);
    expect(line(view([row({ state: 'refused', held_for: null, error: 'No.', answered_at: '2026-11-18T21:04:00Z' })], { on: false }))).toEqual(off);
    const earlier = row({ state: 'attached', held_for: null, file_id: '88001', answered_at: '2026-11-10T21:04:00Z' });
    expect(line(view([earlier], { on: false, version: 2 })).text).toBe(`${off.text}${STILL}`);
  });

  it('says the next run sends it, for a copy made since Invoice PDFs went on', () => {
    expect(line(view([]))).toEqual({
      text: 'FleetSuite sends its PDF of this invoice to NetSuite on its next run, every two hours.', tone: 'muted', canSend: true,
    });
    // Made the moment it went on counts.
    expect(line(view([], { madeAt: ON })).text).toMatch(/on its next run/);
    const earlier = row({ state: 'attached', held_for: null, file_id: '88001', answered_at: '2026-11-10T21:04:00Z' });
    expect(line(view([earlier], { version: 2 })).text).toBe(`FleetSuite sends its PDF of this invoice to NetSuite on its next run, every two hours.${STILL}`);
  });

  it('says only a super admin sends one made before it went on', () => {
    const before = {
      text: 'FleetSuite made this copy before Invoice PDFs went on, so it sends its PDF only when a super admin sends it from here.',
      tone: 'muted',
      canSend: true,
    };
    expect(line(view([], { madeAt: '2026-10-31T23:59:59Z' }))).toEqual(before);
    expect(line(view([], { since: null }))).toEqual(before);
    expect(line(view([], { since: 'not a time' }))).toEqual(before);
    expect(line(view([], { madeAt: 'not a time' }))).toEqual(before);
  });

  it("holds it back while the copy doesn't match NetSuite's invoice, says why, and when it looks again", () => {
    expect(line(view([row()]), 'differs')).toEqual({
      text: "FleetSuite's PDF is held back: this copy differs from NetSuite's invoice. FleetSuite looks again each day.",
      tone: 'warn',
      canSend: false,
    });
    expect(line(view([row({ held_for: 'incomplete' })]), 'incomplete').text).toBe(
      "FleetSuite's PDF is held back: this copy is incomplete, so FleetSuite can't be sure it shows what NetSuite's invoice does. "
      + 'FleetSuite looks again each day.',
    );
    expect(line(view([row({ held_for: 'waiting' })]), 'waiting')).toEqual({
      text: "FleetSuite's PDF waits until FleetSuite has copied NetSuite's invoice, which it does every two hours. FleetSuite looks again on each run.",
      tone: 'muted',
      canSend: false,
    });
    // Waiting three days on, it looks once a day; from 60 days on, not on its own.
    const madeAt = (days: number) => new Date(NOW - days * DAY).toISOString();
    expect(line(view([row({ held_for: 'waiting' })], { madeAt: madeAt(2.9) }), 'waiting').text).toMatch(/looks again on each run\.$/);
    expect(line(view([row({ held_for: 'waiting' })], { madeAt: madeAt(3) }), 'waiting').text).toMatch(/looks again each day\.$/);
    const since = '2026-01-01T00:00:00Z';
    expect(line(view([row()], { since, madeAt: madeAt(59.9) }), 'differs').text).toMatch(/looks again each day\.$/);
    expect(line(view([row()], { since, madeAt: madeAt(60) }), 'differs').text).toMatch(/FleetSuite doesn't look again on its own\.$/);
    expect(line(view([row({ held_for: 'waiting' })], { since, madeAt: madeAt(60) }), 'waiting').text).toMatch(/doesn't look again on its own\.$/);
    // Nor after three tries, or for a copy made before it went on.
    expect(line(view([row({ tries: PDF_TRIES - 1 })]), 'differs').text).toMatch(/looks again each day\.$/);
    expect(line(view([row({ tries: PDF_TRIES })]), 'differs').text).toMatch(/doesn't look again on its own\.$/);
    expect(line(view([row()], { since: '2026-11-18T00:00:00Z' }), 'differs').text).toMatch(/doesn't look again on its own\.$/);
    // When it was held for one reason and now doesn't match for another, the reason is today's; the wait is the hold's.
    expect(line(view([row({ held_for: 'waiting' })]), 'differs').text)
      .toBe("FleetSuite's PDF is held back: this copy differs from NetSuite's invoice. FleetSuite looks again on each run.");
    expect(line(view([row()]), 'waiting').text).toMatch(/^FleetSuite's PDF waits until .* FleetSuite looks again each day\.$/);
  });

  it("holds back one the run hasn't looked at yet, or NetSuite answered before, once the copy doesn't match", () => {
    expect(line(view([]), 'differs')).toEqual({
      text: "FleetSuite's PDF is held back: this copy differs from NetSuite's invoice. FleetSuite looks again each day.",
      tone: 'warn',
      canSend: false,
    });
    expect(line(view([]), 'waiting').text).toMatch(/looks again on each run\.$/);
    expect(line(view([], { madeAt: '2026-10-31T23:59:59Z' }), 'differs').text).toMatch(/doesn't look again on its own\.$/);
    const refused = row({ state: 'refused', held_for: null, tries: 1, error: 'No.', answered_at: '2026-11-18T21:04:00Z' });
    expect(line(view([refused]), 'incomplete')).toEqual({
      text: "FleetSuite's PDF is held back: this copy is incomplete, so FleetSuite can't be sure it shows what NetSuite's invoice does. "
        + 'FleetSuite looks again each day.',
      tone: 'warn',
      canSend: false,
    });
    const stale = row({ state: 'sending', held_for: null, file_name: 'Invoice_INV1_1.pdf', tries: 1, started_at: '2026-11-18T21:45:00Z' });
    expect(line(view([stale]), 'differs').canSend).toBe(false);
    const earlier = row({ state: 'attached', held_for: null, file_id: '88001', answered_at: '2026-11-10T21:04:00Z' });
    expect(line(view([earlier], { version: 2 }), 'differs').text).toMatch(/looks again each day\. NetSuite's invoice still has FleetSuite's PDF from before the invoice was fixed\.$/);
  });

  it('says the run sends one it held back once the copy matches, and a super admin can send it now', () => {
    expect(line(view([row()]))).toEqual({
      text: "FleetSuite held its PDF back, but this copy matches NetSuite's invoice now. FleetSuite sends it when it looks again, within a day.",
      tone: 'muted',
      canSend: true,
    });
    expect(line(view([row({ held_for: 'waiting' })])).text).toMatch(/matches NetSuite's invoice now\. FleetSuite sends it on its next run\.$/);
    const madeAt = (days: number) => new Date(NOW - days * DAY).toISOString();
    expect(line(view([row({ held_for: 'waiting' })], { madeAt: madeAt(3) })).text).toMatch(/sends it when it looks again, within a day\.$/);
    // The run doesn't look at it again: a super admin sends it.
    const byHand = /FleetSuite sends it only when a super admin sends it from here\.$/;
    expect(line(view([row()], { since: '2026-01-01T00:00:00Z', madeAt: madeAt(60) })).text).toMatch(byHand);
    expect(line(view([row({ tries: PDF_TRIES })])).text).toMatch(byHand);
    expect(line(view([row()], { madeAt: '2026-10-31T23:59:59Z' })).text).toMatch(byHand);
    expect(line(view([row({ held_for: 'voided' })]))).toEqual({
      text: "FleetSuite held its PDF back, but this copy matches NetSuite's invoice now. FleetSuite sends it only when a super admin sends it from here.",
      tone: 'muted',
      canSend: true,
    });
  });

  it('sends nothing of an invoice NetSuite voided', () => {
    const voided = { text: 'NetSuite voided this invoice, so FleetSuite sends no PDF of it.', tone: 'muted', canSend: false };
    expect(line(view([row({ held_for: 'voided' })]), 'voided')).toEqual(voided);
    expect(line(view([]), 'voided')).toEqual(voided);
    expect(line(view([], { madeAt: '2026-10-31T23:59:59Z' }), 'voided')).toEqual(voided);
    expect(line(view([row({ state: 'refused', held_for: null, tries: 3, error: 'No.', answered_at: '2026-11-18T21:04:00Z' })]), 'voided')).toEqual(voided);
  });

  it("says it's on its way, then that FleetSuite never heard back 15 minutes on", () => {
    const sending = row({ state: 'sending', held_for: null, file_name: 'Invoice_INV1_1.pdf', tries: 1, started_at: '2026-11-18T21:50:00Z' });
    expect(line(view([sending]))).toEqual({
      text: "FleetSuite's PDF is on its way to NetSuite, sent Nov 18, 3:50 PM.", tone: 'muted', canSend: false,
    });
    expect(line(view([{ ...sending, asked_by_name: 'Craig George' }])).text)
      .toBe("FleetSuite's PDF is on its way to NetSuite, sent Nov 18, 3:50 PM by Craig George.");
    const stale = { ...sending, started_at: '2026-11-18T21:45:00Z' };
    expect(line(view([stale]))).toEqual({
      text: 'FleetSuite sent its PDF at Nov 18, 3:45 PM and never heard back from NetSuite. It sends it again on its next run.',
      tone: 'bad',
      canSend: true,
    });
    expect(line(view([{ ...sending, started_at: '2026-11-18T21:45:01Z' }])).canSend).toBe(false);
    // On its way is on its way, whatever the copy says now.
    expect(line(view([sending]), 'differs').text).toBe("FleetSuite's PDF is on its way to NetSuite, sent Nov 18, 3:50 PM.");
    expect(line(view([{ ...stale, tries: 3 }])).text).toBe(
      "FleetSuite sent its PDF at Nov 18, 3:45 PM and never heard back from NetSuite. FleetSuite has tried 3 times and won't again on its own.",
    );
    expect(line(view([stale], { since: '2026-11-18T00:00:00Z' })).text).toBe(
      'FleetSuite sent its PDF at Nov 18, 3:45 PM and never heard back from NetSuite. FleetSuite sends it again only when a super admin sends it from here.',
    );
    expect(line(view([{ ...stale, started_at: null }])).text)
      .toBe('FleetSuite sent its PDF and never heard back from NetSuite. It sends it again on its next run.');
  });

  it('says what NetSuite said when it refused it, and when FleetSuite tries again', () => {
    const refused = row({ state: 'refused', held_for: null, tries: 1, error: 'You do not have permission to attach files', answered_at: '2026-11-18T21:04:00Z' });
    expect(line(view([refused]))).toEqual({
      text: "NetSuite refused FleetSuite's PDF: You do not have permission to attach files. FleetSuite tries again after Nov 19, 11:04 AM.",
      tone: 'bad',
      canSend: true,
    });
    expect(line(view([{ ...refused, asked_by_name: 'Craig George', error: 'Locked period!' }])).text)
      .toBe("NetSuite refused FleetSuite's PDF by Craig George: Locked period! FleetSuite tries again after Nov 19, 11:04 AM.");
    expect(line(view([{ ...refused, error: '  ' }])).text).toMatch(/^NetSuite refused FleetSuite's PDF: NetSuite gave no reason\. /);
    expect(line(view([{ ...refused, tries: 3 }])).text).toBe(
      "NetSuite refused FleetSuite's PDF: You do not have permission to attach files. FleetSuite has tried 3 times and won't again on its own.",
    );
    expect(line(view([{ ...refused, answered_at: null }])).text).toBe("NetSuite refused FleetSuite's PDF: You do not have permission to attach files.");
    const long = line(view([{ ...refused, error: `Bad\n${'word '.repeat(80)}` }])).text;
    expect(long).toMatch(/^NetSuite refused FleetSuite's PDF: Bad word word /);
    expect(long).toContain('word… FleetSuite tries again');
    expect(long.length).toBeLessThan(340);
  });

  it("says FleetSuite isn't sure NetSuite has it, and that sending again never puts two on", () => {
    const unsure = row({ state: 'unsure', held_for: null, tries: 1, error: "NetSuite didn't answer in time.", answered_at: '2026-11-18T21:04:00Z' });
    expect(line(view([unsure]))).toEqual({
      text: "FleetSuite isn't sure NetSuite has its PDF: NetSuite didn't answer in time. FleetSuite sends it again after Nov 18, 4:04 PM, "
        + 'and NetSuite never ends up with two.',
      tone: 'bad',
      canSend: true,
    });
    expect(line(view([{ ...unsure, tries: 3 }])).text).toBe(
      "FleetSuite isn't sure NetSuite has its PDF: NetSuite didn't answer in time. FleetSuite has tried 3 times and won't again on its own.",
    );
    const earlier = row({ state: 'attached', held_for: null, file_id: '88001', answered_at: '2026-11-10T21:04:00Z' });
    expect(line(view([{ ...unsure, version: 2 }, earlier], { version: 2 })).text).toMatch(/never ends up with two\. NetSuite's invoice still has FleetSuite's PDF from before the invoice was fixed\.$/);
  });

  it("goes by the copy's current version, not one before it", () => {
    const earlier = row({ state: 'refused', held_for: null, tries: 3, error: 'No.', answered_at: '2026-11-10T21:04:00Z' });
    expect(line(view([earlier], { version: 2 })).text).toBe('FleetSuite sends its PDF of this invoice to NetSuite on its next run, every two hours.');
  });
});
