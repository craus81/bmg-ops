'use client';

import { ReactNode } from 'react';
import { theme } from '@/lib/theme';

// Shared wrapper for all widgets — provides the card frame, title, loading state
interface WidgetShellProps {
  title: string;
  icon: string;
  loading?: boolean;
  children: ReactNode;
  onHeaderClick?: () => void;
  accentColor?: string;
}

export default function WidgetShell({ title, icon, loading, children, onHeaderClick, accentColor }: WidgetShellProps) {
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
      boxShadow: theme.shadowSm, overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={onHeaderClick}
        style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '12px 14px 8px', flexShrink: 0,
          cursor: onHeaderClick ? 'pointer' : 'default',
        }}
      >
        <span style={{ fontSize: '16px' }}>{icon}</span>
        <span style={{
          fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.6px', color: accentColor || theme.textMuted,
        }}>{title}</span>
      </div>

      {/* Body */}
      <div style={{ flex: 1, padding: '0 14px 12px', overflow: 'auto', minHeight: 0 }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <div style={{
              width: '24px', height: '24px', border: '2px solid var(--border)',
              borderTopColor: 'var(--navy)', borderRadius: '50%',
              animation: 'spin 1s linear infinite',
            }} />
          </div>
        ) : children}
      </div>
    </div>
  );
}
