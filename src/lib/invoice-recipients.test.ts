import { describe, it, expect } from 'vitest';
import { invoiceRecipients } from './invoice-recipients';

describe('invoiceRecipients', () => {
  it('prefills the billing addresses and lists everyone, billing first, deduped', () => {
    const r = invoiceRecipients({
      billingEmails: ['AP@Hosemate.com'],
      apEmail: 'ap@hosemate.com',
      billingContactEmail: 'pat@hosemate.com',
      contacts: [
        { name: 'Sam Buyer', email: 'sam@hosemate.com', title: 'Fleet manager' },
        { name: 'Pat', email: 'PAT@hosemate.com', is_primary: true },
      ],
      recent: ['old@hosemate.com', 'ap@hosemate.com'],
    });
    expect(r.prefill).toEqual(['ap@hosemate.com', 'pat@hosemate.com']);
    expect(r.suggestions.map(s => [s.email, s.kind])).toEqual([
      ['ap@hosemate.com', 'billing'],
      ['pat@hosemate.com', 'billing'],
      ['sam@hosemate.com', 'contact'],
      ['old@hosemate.com', 'recent'],
    ]);
    expect(r.suggestions[2].label).toBe('Sam Buyer · Fleet manager');
  });

  it('falls back to the primary contact, then the last invoice recipient', () => {
    expect(invoiceRecipients({
      contacts: [{ name: 'A', email: 'a@x.com' }, { name: 'B', email: 'b@x.com', is_primary: true }],
      recent: ['r@x.com'],
    }).prefill).toEqual(['b@x.com']);
    expect(invoiceRecipients({ contacts: [{ name: 'A', email: 'a@x.com' }, { name: 'C', email: 'c@x.com' }], recent: ['r@x.com'] }).prefill).toEqual(['r@x.com']);
    expect(invoiceRecipients({ contacts: [{ name: 'A', email: 'a@x.com' }] }).prefill).toEqual(['a@x.com']);
  });

  it('leaves the box empty when it knows no one, and drops bad addresses', () => {
    const r = invoiceRecipients({ billingEmails: ['not an email', null], contacts: [{ name: 'No email', email: null }] });
    expect(r).toEqual({ prefill: [], suggestions: [] });
  });
});
