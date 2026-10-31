import { describe, it, expect } from 'vitest';
import {
  docRef, parseDocRef, docRefsFromContextUrl, isInternalOnly, summarizeSends,
  sendLine, sendTone, sentChipText, documentNumbersIn, approvalFallbackEvent, type SendEvent,
} from './document-sends';

const ID = '11111111-2222-3333-4444-555555555555';
const ev = (over: Partial<SendEvent>): SendEvent => ({
  at: '2026-10-31T05:41:00.000Z', source: 'email', kind: 'invoice', method: null, by: 'Craig',
  to: ['ap@hosemate.com'], status: 'delivered', detail: null, mailbox: null, emailLogId: null, ...over,
});
const NOW = new Date('2026-10-31T12:00:00Z');

describe('doc refs', () => {
  it('builds and parses', () => {
    expect(docRef('invoice', ' INV1512 ')).toBe('invoice:INV1512');
    expect(parseDocRef('sales_order:SO1177')).toEqual({ type: 'sales_order', key: 'SO1177' });
    expect(parseDocRef('nope:1')).toBeNull();
    expect(parseDocRef('estimate:')).toBeNull();
  });

  it('reads the document an older email was about from its deep link', () => {
    expect(docRefsFromContextUrl(`/estimates?id=${ID}&note=field`, 'estimate_approval')).toEqual([`estimate:${ID}`]);
    expect(docRefsFromContextUrl(`/admin/pos/${ID}`, 'po_confirmation')).toEqual([`customer_po:${ID}`]);
    expect(docRefsFromContextUrl(`/graphics/${ID}?schedule=1`, 'proof_approval')).toEqual([`graphics_job:${ID}`]);
    expect(docRefsFromContextUrl(`/admin/wrap-quote?id=${ID}`, 'wrap_quote')).toEqual([`wrap_quote:${ID}`]);
    expect(docRefsFromContextUrl('/admin/prospects/ns-4521', 'statement')).toEqual(['statement:4521']);
    expect(docRefsFromContextUrl('/admin/prospects/ns-4521', 'other')).toEqual([]);
    expect(docRefsFromContextUrl('/invoices?tab=sent&invoice=INV1512', 'invoice')).toEqual(['invoice:INV1512']);
    expect(docRefsFromContextUrl('/invoices?tab=sent', 'invoice')).toEqual([]);
    expect(docRefsFromContextUrl(null)).toEqual([]);
  });
});

describe('summaries and lines', () => {
  it('treats a send only to BMG addresses as a test', () => {
    expect(isInternalOnly(['craig@bmgfleet.com'])).toBe(true);
    expect(isInternalOnly(['craig@bmgfleet.com', 'ap@hosemate.com'])).toBe(false);
    expect(isInternalOnly([])).toBe(false);
  });

  it('picks the newest real send as latest and keeps tests in history', () => {
    const real = ev({ at: '2026-10-30T10:00:00Z' });
    const test = ev({ at: '2026-10-31T10:00:00Z', to: ['craig@bmgfleet.com'] });
    const s = summarizeSends([real, test]);
    expect(s.latest).toBe(real);
    expect(s.history[0]).toBe(test);
    expect(summarizeSends([]).latest).toBeNull();
  });

  it('reads like the preview', () => {
    expect(sendLine(ev({}), NOW)).toMatch(/^✉ Emailed 10\/31 \d{1,2}:41 [AP]M by Craig to ap@hosemate.com · Delivered$/);
    expect(sendLine(ev({ kind: 'estimate_approval', status: 'bounced', detail: 'address does not exist' }), NOW))
      .toMatch(/Sent for approval .* · Bounced: address does not exist$/);
    expect(sendLine(ev({ by: null, kind: 'po_confirmation', status: 'sent' }), NOW)).toMatch(/PO confirmation emailed .*\(automatic\) .*Waiting for delivery/);
    expect(sendLine(ev({ source: 'mark', method: 'netsuite', by: 'Jessie', status: null }), NOW)).toMatch(/^✉ Marked sent .* by Jessie · emailed from NetSuite to ap@hosemate.com$/);
    expect(sendLine(ev({ source: 'found', method: 'sent_mail', mailbox: 'Jessie', by: null, status: null }), NOW)).toMatch(/^✉ Found in Jessie's sent mail /);
    expect(sendLine(ev({ to: ['craig@bmgfleet.com'] }), NOW)).toMatch(/^✉ Test to craig@bmgfleet.com .*doesn't count as sent/);
  });

  it('colours and chips', () => {
    expect(sendTone(null)).toBe('none');
    expect(sendTone(ev({}))).toBe('ok');
    expect(sendTone(ev({ status: 'sent' }))).toBe('wait');
    expect(sendTone(ev({ status: 'complained' }))).toBe('bad');
    expect(sendTone(ev({ source: 'mark', status: null }))).toBe('wait');
    expect(sentChipText(undefined)).toBe('Not sent');
    expect(sentChipText(summarizeSends([ev({})], { count: 3, lastAt: null }))).toMatch(/· Delivered · 👁 3$/);
    expect(sentChipText(summarizeSends([ev({ status: 'bounced' })]))).toMatch(/· Bounced$/);
    expect(sentChipText(summarizeSends([ev({ source: 'mark', status: null })]))).toMatch(/· Marked sent$/);
  });
});

describe('documentNumbersIn', () => {
  it('finds each kind of number in a subject and file names', () => {
    const n = documentNumbersIn('Re: Estimate EST-2610-076 and Invoice-PF-2610-004.pdf, INV1512.pdf, SO1177, PO 2231');
    expect(n.estimates).toEqual(['EST-2610-076']);
    expect(n.proFormas).toEqual(['PF-2610-004']);
    expect(n.invoices).toEqual(['INV1512']);
    expect(n.salesOrders).toEqual(['SO1177']);
    expect(n.purchaseOrders).toEqual(['PO2231']);
  });
  it('ignores words that only look close', () => {
    const n = documentNumbersIn('Invoice for SOLAR panels, POST 12, investment');
    expect(n).toEqual({ estimates: [], proFormas: [], invoices: [], salesOrders: [], purchaseOrders: [] });
  });
});

describe('approvalFallbackEvent', () => {
  const cols = {
    sent_for_approval_at: '2026-10-29T14:00:00Z', sent_for_approval_by: 'u1',
    approval_email_to: ['jerry@clementford.com'], approval_email_status: 'delivered', approval_email_detail: null,
  };
  it('shows a fleet sibling as sent from its own columns', () => {
    const e = approvalFallbackEvent(cols, []);
    expect(e).toMatchObject({ kind: 'estimate_approval', to: ['jerry@clementford.com'], status: 'delivered', by: 'u1' });
    expect(sentChipText(summarizeSends([e!]))).toMatch(/· Delivered$/);
  });
  it('adds nothing when the send is already logged, or never happened', () => {
    expect(approvalFallbackEvent(cols, [ev({ kind: 'estimate_approval', at: '2026-10-29T14:00:05Z' })])).toBeNull();
    expect(approvalFallbackEvent({ ...cols, sent_for_approval_at: null }, [])).toBeNull();
  });
  it('still adds an older send when only a later one is logged', () => {
    expect(approvalFallbackEvent(cols, [ev({ kind: 'estimate_approval', at: '2026-10-31T09:00:00Z' })])).not.toBeNull();
  });
  it('reads a text-only send as texted', () => {
    expect(approvalFallbackEvent({ ...cols, approval_email_to: [] }, [])?.kind).toBe('estimate_approval_sms');
  });
});
