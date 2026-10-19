'use client';

/**
 * A page card whose body folds shut under its title (Craig, 2026-10-19: "a
 * way to collapse ... so we don't have to scroll so much ... the
 * expand/collapse state should save for future viewings").
 *
 * Tapping the title flips it. The choice is saved per user on their profile
 * (`profiles.collapsed_sections`, migration 408) as '<page>:<id>', so it
 * follows them from the iPhone app to the desktop. Every card starts open.
 *
 * `note` (a total beside the title) and `extra` (right-hand facts, a Save
 * button that must never hide) stay visible when folded. `actions` (+ Add,
 * filters) only show while open, since what they open lives in the body. The body
 * is unmounted while folded, so a folded section also skips its loads.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useAuth } from '@/components/AuthProvider';

const cardStyle: CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px 16px' };
const titleStyle: CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)' };

/** Is this section folded for the signed-in user, and a setter. */
export function useCollapsed(page: string, id: string): [boolean, (collapsed: boolean) => void] {
  const { profile, setSectionCollapsed } = useAuth();
  const key = `${page}:${id}`;
  return [!!profile?.collapsed_sections?.includes(key), c => setSectionCollapsed(key, c)];
}

export default function CollapsibleCard({ page, id, title, note, extra, actions, children, style }: {
  page: string;
  id: string;
  title: ReactNode;
  note?: ReactNode;
  extra?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const [collapsed, setCollapsed] = useCollapsed(page, id);
  return (
    <div style={{ ...cardStyle, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Show this section' : 'Hide this section — stays hidden next time'}
          style={{ ...titleStyle, display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', padding: '4px 0', margin: '-4px 0', cursor: 'pointer', textAlign: 'left' }}
        >
          <span aria-hidden style={{ fontSize: '9px', width: '9px', display: 'inline-block', transition: 'transform 0.15s', transform: collapsed ? 'rotate(-90deg)' : 'none' }}>▾</span>
          <span>{title}</span>
        </button>
        {note}
        <span style={{ flex: 1 }} />
        {extra}
        {!collapsed && actions}
      </div>
      {!collapsed && <div style={{ marginTop: '8px' }}>{children}</div>}
    </div>
  );
}
