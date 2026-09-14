import { describe, it, expect } from 'vitest';
import {
  resolvePref,
  prefState,
  mayReceive,
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
    // Both opt-IN (migration 171): silence until someone says yes.
    expect(resolvePref('status_emails', {})).toBe(false);
    expect(resolvePref('weekly_digest', {})).toBe(false);
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
    const company = { notify_status_emails: true, weekly_digest: false };
    expect(mayReceive('status_emails', company, null)).toBe(true);
    expect(mayReceive('weekly_digest', company, null)).toBe(false);
  });
  it('treats a contact row with no override as inherit, not as off', () => {
    const company = { notify_status_emails: true };
    expect(mayReceive('status_emails', company, {})).toBe(true);
  });
});

