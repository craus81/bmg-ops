'use client';

/**
 * The Settings notification matrix (R6-13) — rows are alert types grouped
 * by area, columns are In-app / Push / Email.
 *
 * Built entirely from src/lib/notification-registry.ts so the page can
 * never again show fewer types than the app sends. What it replaced was
 * four checkboxes resolved by substring match, which between them governed
 * three of ~64 types; one of them ("Shipped") matched nothing at all.
 *
 * Three things this renders honestly:
 *
 *  - A type that ignores preferences by design (assignment,
 *    graphics_ready_for_install) is LOCKED with the reason, not shown as a
 *    checkbox that silently does nothing.
 *  - A type whose audience is decided elsewhere says so on the row, because
 *    ticking a channel box cannot subscribe you to something you are not
 *    targeted for.
 *  - A row with no explicit choice shows what it is inheriting, so
 *    "following your account defaults" never looks like a decision you made.
 */

import { useMemo } from 'react';
import {
  typesByArea,
  channelsForType,
  parseOverrides,
  type NotifyChannelKey,
  type TypeChannelOverrides,
} from '@/lib/notification-registry';

const CHANNELS: { key: NotifyChannelKey; label: string }[] = [
  { key: 'in_app', label: 'In-app' },
  { key: 'push', label: 'Push' },
  { key: 'email', label: 'Email' },
];

export interface NotificationMatrixProps {
  /** The stored per-type overrides (notification_preferences.type_channels). */
  overrides: unknown;
  /** Account-wide switches, so an inherited row can show what it inherits. */
  accountInApp: boolean;
  accountEmail: boolean;
  onChange: (next: TypeChannelOverrides) => void;
}

export default function NotificationMatrix({ overrides, accountInApp, accountEmail, onChange }: NotificationMatrixProps) {
  const parsed = useMemo(() => parseOverrides(overrides), [overrides]);
  const groups = useMemo(() => typesByArea(), []);
  const accountPrefs = { notify_in_app: accountInApp, notify_email: accountEmail, type_channels: parsed };

  const toggle = (type: string, channel: NotifyChannelKey, current: NotifyChannelKey[]) => {
    const has = current.includes(channel);
    const next = has ? current.filter(c => c !== channel) : [...current, channel];
    // Writing the key at all converts the row from inherited to explicit —
    // which is what the user just did by touching it.
    onChange({ ...parsed, [type]: next });
  };

  const reset = (type: string) => {
    const next = { ...parsed };
    delete next[type];
    onChange(next);
  };

  const cell: React.CSSProperties = { width: '62px', textAlign: 'center', padding: '6px 0' };
  const head: React.CSSProperties = { ...cell, fontSize: '10px', fontWeight: 800, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.6px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-label)', lineHeight: 1.5 }}>
        Every alert FleetSuite can send is listed here. A row you haven&apos;t touched follows your
        account defaults below; tick or untick anything to decide it yourself.
      </div>

      {groups.map(group => (
        <div key={group.area}>
          <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>{group.label}</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '460px' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }} />
                  {CHANNELS.map(c => <th key={c.key} style={head}>{c.label}</th>)}
                  <th style={{ ...head, width: '70px' }} />
                </tr>
              </thead>
              <tbody>
                {group.types.map(def => {
                  const explicit = Object.prototype.hasOwnProperty.call(parsed, def.type);
                  const active = channelsForType(def.type, accountPrefs);
                  return (
                    <tr key={def.type} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 8px 8px 0' }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>{def.label}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-label)', lineHeight: 1.4 }}>
                          {def.description}
                          {def.audience && <><br /><span style={{ fontStyle: 'italic' }}>Who gets it: {def.audience}</span></>}
                          {def.alwaysOn && <><br /><span style={{ fontStyle: 'italic' }}>{def.alwaysOn}</span></>}
                          {!def.alwaysOn && !explicit && <><br /><span style={{ opacity: 0.8 }}>Following your account defaults.</span></>}
                        </div>
                      </td>
                      {CHANNELS.map(c => (
                        <td key={c.key} style={cell}>
                          <input
                            type="checkbox"
                            checked={active.includes(c.key)}
                            disabled={!!def.alwaysOn}
                            title={def.alwaysOn || undefined}
                            onChange={() => toggle(def.type, c.key, active)}
                            style={{ cursor: def.alwaysOn ? 'not-allowed' : 'pointer', opacity: def.alwaysOn ? 0.45 : 1 }}
                          />
                        </td>
                      ))}
                      <td style={{ ...cell, width: '70px' }}>
                        {explicit && !def.alwaysOn && (
                          <button
                            type="button"
                            onClick={() => reset(def.type)}
                            style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '10px', fontWeight: 700, cursor: 'pointer', padding: 0 }}
                          >
                            Reset
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
