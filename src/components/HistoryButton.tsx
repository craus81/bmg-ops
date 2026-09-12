'use client';

/**
 * History control (R6-13) — opens the audit log filtered to this one
 * record.
 *
 * Only rendered for people who hold the audit feature. That is not
 * decoration: the audit page itself is admin-gated, so showing the button
 * to everyone else would be a link that 403s, and a control that cannot
 * work is worse than no control.
 */

import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { deepLinks } from '@/lib/deep-links';

export interface HistoryButtonProps {
  /** The real table name — audit_log.table_name stores exactly this. */
  table: string;
  recordId: string | null | undefined;
  /** Compact renders as a small text link for tight toolbars. */
  compact?: boolean;
  label?: string;
}

export default function HistoryButton({ table, recordId, compact, label }: HistoryButtonProps) {
  const router = useRouter();
  const { isAdmin, hasFeature } = useAuth();
  // No id means there is nothing to filter to — a button that opened the
  // whole unfiltered log would be a different feature wearing this label.
  if (!recordId) return null;
  if (!isAdmin && !hasFeature('audit_log')) return null;

  const text = label || 'History';
  const style: React.CSSProperties = compact
    ? { background: 'none', border: 'none', color: 'var(--accent)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', padding: '2px 4px' }
    : {
      padding: '7px 14px', borderRadius: '8px', border: '1px solid var(--border)',
      background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    };

  return (
    <button type="button" title="Who changed what on this record" style={style}
      onClick={() => router.push(deepLinks.recordHistory(table, recordId))}>
      {compact ? text : `🕘 ${text}`}
    </button>
  );
}
