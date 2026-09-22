import { describe, it, expect } from 'vitest';
import {
  MERGE_FIELDS, usedMergeFields, unknownMergeTokens, applyMerge, buildAudience,
  MAX_RECIPIENTS, SKIP_LABEL,
} from './segment-blast';

const row = (over: Partial<Parameters<typeof applyMerge>[1]> = {}) => ({
  id: 'r1', company_name: 'Acme Fleet', contact_name: 'Dana Ruiz',
  email: 'dana@acme.example', email_campaign: true, ...over,
});

describe('applyMerge', () => {
  it('fills every known field', () => {
    expect(applyMerge('Hi {{contact_first_name}} at {{company}} — {{contact_name}}', row()))
      .toBe('Hi Dana at Acme Fleet — Dana Ruiz');
  });

  it('replaces every occurrence, not just the first', () => {
    expect(applyMerge('{{company}} / {{company}}', row())).toBe('Acme Fleet / Acme Fleet');
  });

  it('leaves a token alone when the recipient has no value, so the gap is visible', () => {
    // buildAudience is what actually keeps this from being sent; applyMerge
    // must not quietly produce "Hi ,".
    expect(applyMerge('Hi {{contact_first_name}},', row({ contact_name: null })))
      .toBe('Hi {{contact_first_name}},');
  });
});

describe('usedMergeFields / unknownMergeTokens', () => {
  it('finds only the fields the template actually uses', () => {
    expect(usedMergeFields('Hello {{company}}').map(f => f.token)).toEqual(['{{company}}']);
  });

  it('flags a token that looks like a merge field but is not one — a typo reaches the customer verbatim', () => {
    expect(unknownMergeTokens('Hi {{frist_name}} at {{company}}')).toEqual(['{{frist_name}}']);
  });

  it('reports each unknown token once', () => {
    expect(unknownMergeTokens('{{nope}} {{nope}}')).toEqual(['{{nope}}']);
  });

  it('is empty when everything is known', () => {
    expect(unknownMergeTokens('Hi {{contact_first_name}}')).toEqual([]);
  });
});

describe('buildAudience', () => {
  it('sends to an opted-in record with an address', () => {
    const a = buildAudience([row()], 'Hello');
    expect(a.sendable.map(s => s.email)).toEqual(['dana@acme.example']);
    expect(a.skipped).toEqual([]);
  });

  it('NEVER sends to a record that has not opted in, whatever the filter said', () => {
    const a = buildAudience([row({ email_campaign: false })], 'Hello');
    expect(a.sendable).toEqual([]);
    expect(a.skipped[0].reason).toBe('not_opted_in');
  });

  it('treats a missing opt-in flag as no consent, not as consent unknown', () => {
    expect(buildAudience([row({ email_campaign: null })], 'Hello').sendable).toEqual([]);
  });

  it('skips a record with no address and says so', () => {
    expect(buildAudience([row({ email: null })], 'Hello').skipped[0].reason).toBe('no_email');
  });

  it('sends once to an address two records share', () => {
    const a = buildAudience([row(), row({ id: 'r2', company_name: 'Acme Depot' })], 'Hello');
    expect(a.sendable).toHaveLength(1);
    expect(a.skipped[0].reason).toBe('duplicate_email');
  });

  it('normalizes case when deduping — DANA@ and dana@ are one inbox', () => {
    const a = buildAudience([row(), row({ id: 'r2', email: 'DANA@acme.example' })], 'Hello');
    expect(a.sendable).toHaveLength(1);
  });

  it('refuses a recipient missing a field the template fills — "Hi ," is worse than no send', () => {
    const a = buildAudience([row({ contact_name: null })], 'Hi {{contact_first_name}},');
    expect(a.sendable).toEqual([]);
    expect(a.skipped[0].reason).toBe('missing_merge_field');
    expect(a.skipped[0].detail).toBe('Contact first name');
  });

  it('does not mind a missing field the template never uses', () => {
    expect(buildAudience([row({ contact_name: null })], 'Hello {{company}}').sendable).toHaveLength(1);
  });

  it('flags a segment too large for one run instead of silently truncating it', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) =>
      row({ id: `r${i}`, email: `p${i}@acme.example` }));
    expect(buildAudience(many, 'Hello').overCap).toBe(true);
  });

  it('preserves the caller ordering so the sender sees their own sort', () => {
    const a = buildAudience([
      row({ id: 'b', email: 'b@x.example', company_name: 'B' }),
      row({ id: 'a', email: 'a@x.example', company_name: 'A' }),
    ], 'Hello');
    expect(a.sendable.map(s => s.companyName)).toEqual(['B', 'A']);
  });
});

describe('labels', () => {
  it('has a human sentence for every skip reason, so the screen never shows a bare code', () => {
    for (const r of ['no_email', 'not_opted_in', 'duplicate_email', 'missing_merge_field'] as const) {
      expect(SKIP_LABEL[r]).toBeTruthy();
    }
  });

  it('every merge field has a label a sender can read', () => {
    for (const f of MERGE_FIELDS) expect(f.label.length).toBeGreaterThan(2);
  });
});
