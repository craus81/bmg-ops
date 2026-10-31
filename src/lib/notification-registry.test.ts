import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  NOTIFICATION_TYPES,
  AREA_ORDER,
  AREA_LABEL,
  isRegistered,
  getNotificationType,
  typesByArea,
  parseOverrides,
  channelsForType,
  emailsImmediately,
} from './notification-registry';

/** Every .ts/.tsx under src/, so the sweep cannot miss a directory. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Pull the `type:` literal out of every notify()/notifyMany() call. Same
 * cheap, dumb, impossible-to-satisfy-by-accident trick the route-permission
 * manifest uses.
 */
function dispatchedTypes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk('src')) {
    const src = readFileSync(file, 'utf8');
    const call = /\bnotify(?:Many|ProofDecision)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = call.exec(src))) {
      // The payload's `type:` is within a few lines of the call opening.
      const window = src.slice(m.index, m.index + 600);
      // Every literal in the `type:` expression, so a ternary
      // (`type: ok ? 'a_accepted' : 'a_rejected'`) registers both — the
      // first-literal-only match let estimate_accepted, estimate_rejected
      // and proof_revision_requested ship unregistered, and unregistered
      // types never emailed anyone. Only literals that open the expression
      // or a ternary branch count; `verdict === 'accepted'` is a condition.
      const t = /type:\s*([^,\n]+)/.exec(window);
      if (!t) continue;
      for (const lit of Array.from(t[1].matchAll(/(?:^|[?:]\s*)'([a-z0-9_]+)'/g))) {
        const list = found.get(lit[1]) || [];
        if (!list.includes(file)) list.push(file);
        found.set(lit[1], list);
      }
    }
  }
  return found;
}

describe('the registry covers every type actually dispatched', () => {
  it('has an entry for each notify()/notifyMany() type in src/', () => {
    const missing: string[] = [];
    for (const [type, files] of dispatchedTypes()) {
      if (!isRegistered(type)) missing.push(`${type} (${files[0]})`);
    }
    // A missing type falls back to "allowed" and never appears in Settings,
    // which is precisely the dishonesty the registry replaces. Add the
    // entry in src/lib/notification-registry.ts in the same change.
    expect(missing).toEqual([]);
  });

  it('finds a meaningful number of dispatch sites — the scan itself must not silently break', () => {
    // If the regex or the walk stopped working, the test above would pass
    // vacuously. This is the canary for that.
    expect(dispatchedTypes().size).toBeGreaterThan(40);
  });
});

describe('registry shape', () => {
  it('has no duplicate types', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const t of NOTIFICATION_TYPES) {
      if (seen.has(t.type)) dupes.push(t.type);
      seen.add(t.type);
    }
    expect(dupes).toEqual([]);
  });

  it('gives every type a label, a description and at least one default channel', () => {
    for (const t of NOTIFICATION_TYPES) {
      expect(t.label.length, t.type).toBeGreaterThan(0);
      expect(t.description.length, t.type).toBeGreaterThan(0);
      // An opt-in row starts empty on purpose: ticking it is the subscription.
      if (!t.optIn) expect(t.defaultChannels.length, t.type).toBeGreaterThan(0);
    }
  });

  it('puts every type in an area the matrix renders', () => {
    for (const t of NOTIFICATION_TYPES) {
      expect(AREA_ORDER, t.type).toContain(t.area);
      expect(AREA_LABEL[t.area]).toBeTruthy();
    }
  });

  it('lists every type exactly once across the grouped view', () => {
    const grouped = typesByArea().flatMap(g => g.types.map(t => t.type));
    expect(grouped.sort()).toEqual(NOTIFICATION_TYPES.map(t => t.type).sort());
  });
});

describe('direct messages and mentions', () => {
  it('lets push be switched on or off for both, and defaults it on', () => {
    for (const type of ['message', 'mention']) {
      expect(getNotificationType(type)!.alwaysOn).toBeFalsy();
      expect(channelsForType(type, null)).toContain('push');
      expect(channelsForType(type, { notify_in_app: true, type_channels: { [type]: [] } })).not.toContain('push');
    }
  });

  it('keeps direct-message in-app unconditional and email on its own switch', () => {
    expect(channelsForType('message', { notify_in_app: true, type_channels: { message: [] } })).toEqual(['in_app']);
    expect(channelsForType('message', { notify_in_app: true, email_messages: true })).toEqual(['in_app', 'push', 'email']);
    expect(channelsForType('message', { notify_in_app: true, notify_email: true, type_channels: { message: ['email'] } }))
      .toEqual(['in_app']); // a matrix override can't turn message email on
  });

  it('emails a mention unless the person turned "Email me when I\'m mentioned" off', () => {
    expect(channelsForType('mention', null)).toEqual(['in_app', 'push', 'email']);
    expect(channelsForType('mention', { notify_in_app: true, notify_email: false })).toEqual(['in_app', 'push', 'email']);
    expect(channelsForType('mention', { notify_in_app: true, email_mentions: false })).toEqual(['in_app', 'push']);
    expect(channelsForType('mention', { notify_in_app: true, type_channels: { mention: ['in_app'] } })).toEqual(['in_app', 'email']);
  });
});

describe.each([
  ["Books' Inventory Adjusts", 'books_own_adjustment_differs'],
  ["sends to NetSuite FleetSuite isn't sure about", 'books_netsuite_send_unsure'],
])('%s (Craig, 2026-10-28: new alerts copy him by email)', (_what, type) => {

  it('emails only a super admin with "Copy me on new alerts" ticked, in the app and by push otherwise', () => {
    expect(channelsForType(type, null)).toEqual(['in_app', 'push']);
    expect(channelsForType(type, { notify_in_app: true, notify_email: true })).toEqual(['in_app', 'push']);
    expect(channelsForType(type, { notify_in_app: true, copy_new_alerts: false })).toEqual(['in_app', 'push']);
    expect(channelsForType(type, { notify_in_app: true, copy_new_alerts: true })).toEqual(['in_app', 'push', 'email']);
    // The matrix can't turn its email on, nor off for someone copied; the bell and push stay theirs to choose.
    expect(channelsForType(type, { notify_in_app: true, type_channels: { [type]: ['in_app', 'email'] } })).toEqual(['in_app']);
    expect(channelsForType(type, { notify_in_app: true, copy_new_alerts: true, type_channels: { [type]: [] } })).toEqual(['email']);
  });

  it('emails right away, as the copy of a new alert', () => {
    expect(emailsImmediately(type)).toBe(true);
  });
});

describe('channelsForType', () => {
  const prefsOn = { notify_in_app: true, notify_email: true };
  const prefsInAppOnly = { notify_in_app: true, notify_email: false };

  it('ignores preferences for an always-on type', () => {
    const def = getNotificationType('assignment')!;
    expect(def.alwaysOn).toBeTruthy();
    expect(channelsForType('assignment', { notify_in_app: false, notify_email: false }))
      .toEqual(def.defaultChannels);
  });

  it('uses a per-type override when one is set', () => {
    expect(channelsForType('quote_followup', { ...prefsOn, type_channels: { quote_followup: ['email'] } }))
      .toEqual(['email']);
  });

  it('honours an override of NO channels — that is a choice, not missing data', () => {
    expect(channelsForType('quote_followup', { ...prefsOn, type_channels: { quote_followup: [] } }))
      .toEqual([]);
  });

  it('falls back to the account switches for a type with no override', () => {
    // credit_app_submitted defaults to in_app+push+email; with email off,
    // the account switch removes just that channel.
    expect(channelsForType('credit_app_submitted', prefsInAppOnly)).toEqual(['in_app', 'push']);
    expect(channelsForType('credit_app_submitted', prefsOn)).toEqual(['in_app', 'push', 'email']);
  });

  it('drops in-app AND push together — they are one switch on two surfaces', () => {
    expect(channelsForType('quote_followup', { notify_in_app: false, notify_email: false })).toEqual([]);
  });

  it('uses the type default for a user with no preferences row', () => {
    // Two types with different defaults, so this can't pass by accident on
    // a registry where everything happens to allow every channel.
    expect(channelsForType('cni_payout', null)).toEqual(['in_app', 'push']);
    expect(channelsForType('quote_followup', null)).toEqual(['in_app', 'push', 'email']);
  });

  it('FAILS OPEN for an unregistered type rather than silently dropping it', () => {
    // Dropping an uncatalogued alert is the worse error; the coverage test
    // above is what keeps this branch unreachable.
    expect(channelsForType('not_a_real_type', prefsOn, ['in_app'])).toEqual(['in_app']);
  });
});

describe('parseOverrides', () => {
  it('keeps a valid map', () => {
    expect(parseOverrides({ a: ['in_app', 'email'] })).toEqual({ a: ['in_app', 'email'] });
  });
  it('drops channel names it does not recognise rather than passing them through', () => {
    expect(parseOverrides({ a: ['in_app', 'carrier_pigeon'] })).toEqual({ a: ['in_app'] });
  });
  it('de-duplicates', () => {
    expect(parseOverrides({ a: ['push', 'push'] })).toEqual({ a: ['push'] });
  });
  it('preserves an explicit empty selection', () => {
    expect(parseOverrides({ a: [] })).toEqual({ a: [] });
  });
  it('survives junk in the column', () => {
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides('nope')).toEqual({});
    expect(parseOverrides(['nope'])).toEqual({});
    expect(parseOverrides({ a: 'in_app' })).toEqual({});
  });
});

describe('customer decisions (Craig, 2026-10-20)', () => {
  it('emails the people on the record for every estimate answer, ignoring opt-outs', () => {
    for (const type of ['estimate_accepted', 'estimate_rejected', 'quote_accepted', 'quote_rejected']) {
      const def = getNotificationType(type)!;
      expect(def.alwaysOn, type).toBeTruthy();
      expect(def.emailNow, type).toBe(true);
      expect(channelsForType(type, { notify_email: false, type_channels: { [type]: [] } })).toContain('email');
    }
  });

  it('sends the watch row to nobody until they tick a box', () => {
    expect(channelsForType('customer_decision_watch', null)).toEqual([]);
    expect(channelsForType('customer_decision_watch', { notify_email: true, notify_in_app: true })).toEqual([]);
    expect(channelsForType('customer_decision_watch', { type_channels: { customer_decision_watch: ['email'] } })).toEqual(['email']);
    expect(getNotificationType('customer_decision_watch')!.emailNow).toBe(true);
  });

  it('registers both proof answers', () => {
    expect(isRegistered('proof_approved')).toBe(true);
    expect(isRegistered('proof_revision_requested')).toBe(true);
  });
});
