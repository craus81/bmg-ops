import { describe, it, expect } from 'vitest';
import {
  resolvePref,
  prefState,
  mayReceive,
  filterRecipients,
  indexContactsByEmail,
  COMPANY_DEFAULT,
  PREF_KEYS,
} from './notification-prefs';

describe('resolvePref', () => {
  it('lets a contact override say yes over a company no', () => {
    expect(resolvePref('status_emails', { company: false, contact: true })).toBe(true);
  });
  it('lets a contact override say no over a company yes', () => {
    expect(resolvePref('status_emails', { company: true, contact: false })).toBe(false);
  });
  it('inherits the company setting when the contact has no opinion', () => {
    expect(resolvePref('status_emails', { company: true, contact: null })).toBe(true);
    expect(resolvePref('status_emails', { company: true, contact: undefined })).toBe(true);
    expect(resolvePref('status_emails', { company: false, contact: null })).toBe(false);
  });
  it('falls back to the per-key company default when nothing is set', () => {
    // Not one blanket default: the two opt-IN flags stay off, while
    // estimate reminders were unconditional before and must stay on.
    expect(resolvePref('status_emails', {})).toBe(false);
    expect(resolvePref('weekly_digest', {})).toBe(false);
    expect(resolvePref('estimate_reminders', {})).toBe(true);
  });
  it('has a default for every key', () => {
    for (const key of PREF_KEYS) expect(typeof COMPANY_DEFAULT[key]).toBe('boolean');
  });
});

describe('prefState', () => {
  it('distinguishes an explicit choice from an inherited one', () => {
    expect(prefState('status_emails', { company: false, contact: true })).toBe('on');
    expect(prefState('status_emails', { company: true, contact: false })).toBe('off');
    expect(prefState('status_emails', { company: true, contact: null })).toBe('inherit_on');
    expect(prefState('status_emails', { company: false, contact: null })).toBe('inherit_off');
  });
});

describe('mayReceive', () => {
  it('reads the right column for each key', () => {
    const company = { notify_status_emails: true, weekly_digest: false, notify_estimate_reminders: false };
    expect(mayReceive('status_emails', company, null)).toBe(true);
    expect(mayReceive('weekly_digest', company, null)).toBe(false);
    expect(mayReceive('estimate_reminders', company, null)).toBe(false);
  });
  it('treats a contact row with no override as inherit, not as off', () => {
    const company = { notify_status_emails: true };
    expect(mayReceive('status_emails', company, {})).toBe(true);
  });
});

describe('filterRecipients', () => {
  const company = { notify_estimate_reminders: true };

  it('removes only the person who opted out', () => {
    const contacts = indexContactsByEmail([
      { email: 'jordan@acme.com', notify_estimate_reminders: false },
      { email: 'sam@acme.com', notify_estimate_reminders: true },
    ]);
    expect(filterRecipients('estimate_reminders', ['jordan@acme.com', 'sam@acme.com'], company, contacts))
      .toEqual(['sam@acme.com']);
  });

  it('keeps an address with no contact row on file', () => {
    // No record is not an opt-out. Dropping it would silence someone who
    // never asked to be.
    const contacts = indexContactsByEmail([{ email: 'jordan@acme.com', notify_estimate_reminders: false }]);
    expect(filterRecipients('estimate_reminders', ['nobody@acme.com'], company, contacts))
      .toEqual(['nobody@acme.com']);
  });

  it('matches addresses case-insensitively and ignoring surrounding space', () => {
    const contacts = indexContactsByEmail([{ email: 'Jordan@Acme.com', notify_estimate_reminders: false }]);
    expect(filterRecipients('estimate_reminders', ['  JORDAN@acme.com '], company, contacts)).toEqual([]);
  });

  it('drops blank entries without treating them as recipients', () => {
    expect(filterRecipients('estimate_reminders', ['', '   '], company, new Map())).toEqual([]);
  });

  it('honours a contact opt-IN when the company is off', () => {
    const contacts = indexContactsByEmail([{ email: 'jordan@acme.com', weekly_digest: true }]);
    expect(filterRecipients('weekly_digest', ['jordan@acme.com'], { weekly_digest: false }, contacts))
      .toEqual(['jordan@acme.com']);
  });
});

describe('indexContactsByEmail', () => {
  it('keeps the first row for a duplicated address', () => {
    // A later, emptier duplicate must not erase an opt-out.
    const map = indexContactsByEmail([
      { email: 'jordan@acme.com', notify_status_emails: false },
      { email: 'jordan@acme.com' },
    ]);
    expect(map.get('jordan@acme.com')?.notify_status_emails).toBe(false);
  });
  it('skips rows with no address', () => {
    expect(indexContactsByEmail([{ email: null }, { email: '  ' }]).size).toBe(0);
  });
});
