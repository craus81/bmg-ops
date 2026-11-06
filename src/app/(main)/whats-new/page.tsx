'use client';

/**
 * More → What's new (Craig, 2026-11-06): every release, newest first, with
 * only the lines this person can use. Opening it clears the dot on More and
 * the dashboard banner. The lines live in src/lib/release-notes.json.
 */

import { useEffect, useState } from 'react';
import { ReleaseCard, useWhatsNew } from '@/components/WhatsNew';
import { isNewer } from '@/lib/release-notes';

export default function WhatsNewPage() {
  const { releases, latest, seen, markWhatsNewSeen } = useWhatsNew();
  // What was unseen when the page opened, so "New for you" stays on screen
  // after the visit is saved.
  const [seenAtOpen, setSeenAtOpen] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!latest || seenAtOpen !== undefined) return;
    setSeenAtOpen(seen.page ?? null);
    markWhatsNewSeen({ page: latest.number });
  }, [latest, seen.page, seenAtOpen, markWhatsNewSeen]);

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>What&apos;s new</h1>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.45 }}>
          New features and fixes in FleetSuite. Each day&apos;s changes are one release, numbered by the date. You only see the changes for the parts of the app you use.
        </div>
      </div>
      {releases.length === 0 ? (
        <div style={{ fontSize: '14px', color: 'var(--text-muted)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px 16px' }}>
          Nothing new for you yet. New features and fixes will show here the day they go live.
        </div>
      ) : releases.map(r => (
        <ReleaseCard key={r.number} release={r} fresh={seenAtOpen !== undefined && isNewer(r.number, seenAtOpen)} />
      ))}
    </div>
  );
}
