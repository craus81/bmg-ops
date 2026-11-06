'use client';

/**
 * What's new in FleetSuite (Craig, 2026-11-06): the dashboard banner, the
 * one-time popup, the dot on More and the list on More → What's new. All of
 * them read the same releases (src/lib/release-notes.ts), filtered to what
 * this person can open, and what they've seen is saved on their profile
 * (migration 522).
 *
 *   Popup   — once per release, the first time they open FleetSuite after it
 *             goes live. "Got it" or "See all changes" closes it for good.
 *   Banner  — top of Home until they tap See what's new or ✕.
 *   Dot     — on More until they open the What's new page.
 */

import { useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useNavTabs } from '@/components/useNavTabs';
import { booksAccess } from '@/lib/books/access';
import {
  isBooksOnly, isNewer, releaseDayLabel, releaseSummary, releasesFor, type Release, type ReleaseNote,
} from '@/lib/release-notes';

export const WHATS_NEW_PATH = '/whats-new';

export function useWhatsNew() {
  const { profile, isAdmin, hasRole, hasFeature, markWhatsNewSeen } = useAuth();
  const { customerOnly: customer } = useNavTabs();
  const books = booksAccess(hasRole) !== null;
  const releases = useMemo(
    () => (profile ? releasesFor({ customer, isAdmin, books, hasFeature }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hasFeature changes with the profile/View As
    [profile, customer, isAdmin, books],
  );
  const latest: Release | null = releases[0] ?? null;
  const seen = profile?.whats_new_seen || {};
  const unseenPage = !!latest && isNewer(latest.number, seen.page);
  return {
    releases,
    latest,
    seen,
    /** Red dot on More and "New" on the What's new row. */
    unseenPage,
    showBanner: !!latest && unseenPage && isNewer(latest.number, seen.banner),
    showPopup: !!latest && unseenPage && isNewer(latest.number, seen.popup),
    markWhatsNewSeen,
  };
}

/** The navy banner at the top of Home. */
export function WhatsNewBanner() {
  const router = useRouter();
  const { latest, showBanner, markWhatsNewSeen } = useWhatsNew();
  if (!latest || !showBanner) return null;
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', marginBottom: '14px', borderRadius: '14px', background: 'var(--navy)', color: '#fff' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '12px', opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>Release {latest.number}</div>
        <div style={{ fontSize: '15px', fontWeight: 800 }}>{releaseSummary(latest)} in FleetSuite</div>
      </div>
      <button
        type="button"
        onClick={() => router.push(WHATS_NEW_PATH)}
        style={{ flexShrink: 0, padding: '9px 12px', borderRadius: '10px', border: 'none', background: '#fff', color: 'var(--navy)', fontSize: '13px', fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}
      >See what&apos;s new</button>
      <button
        type="button"
        aria-label="Hide this banner"
        title="Hide this banner"
        onClick={() => markWhatsNewSeen({ banner: latest.number })}
        style={{ flexShrink: 0, background: 'none', border: 'none', color: '#fff', opacity: 0.8, fontSize: '18px', padding: '4px 6px', cursor: 'pointer' }}
      >✕</button>
    </div>
  );
}

/** The one-time popup. Mounted once in the app shell. */
export function WhatsNewPopup() {
  const router = useRouter();
  const pathname = usePathname();
  const { latest, showPopup, markWhatsNewSeen } = useWhatsNew();
  if (!latest || !showPopup || pathname === WHATS_NEW_PATH) return null;
  const close = () => markWhatsNewSeen({ popup: latest.number });
  const shown = latest.notes.filter(n => !isBooksOnly(n));
  const books = latest.notes.length - shown.length;
  const top = shown.slice(0, 4);
  const more = shown.length - top.length + (books ? 1 : 0);
  return (
    <div className="whats-new-overlay" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
      <style>{`
        .whats-new-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(10,20,30,0.55); display: flex; align-items: center; justify-content: center; padding: 20px; }
        .whats-new-box { background: var(--card); color: var(--text-primary); border-radius: 16px; padding: 20px; width: 100%; max-width: 460px; max-height: 85vh; overflow-y: auto; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; }
        @media (max-width: 600px) {
          .whats-new-overlay { padding: 0; align-items: stretch; }
          .whats-new-box { max-width: none; max-height: none; border-radius: 0; padding: calc(20px + env(safe-area-inset-top, 0px)) 20px calc(20px + env(safe-area-inset-bottom, 0px)); }
        }
      `}</style>
      <div className="whats-new-box">
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums' }}>
          RELEASE {latest.number} · {releaseDayLabel(latest.date).toUpperCase()}
        </div>
        <div id="whats-new-title" style={{ fontSize: '20px', fontWeight: 800 }}>What&apos;s new in FleetSuite</div>
        <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', lineHeight: 1.45 }}>
          {top.map((n, i) => (
            <li key={i}>{n.kind === 'fix' ? <b>Fixed: </b> : null}{n.text}</li>
          ))}
          {top.length === 0 && books > 0 && <li>{books} Books change{books === 1 ? '' : 's'}</li>}
          {more > 0 && top.length > 0 && <li><b>+ {more} more</b></li>}
        </ul>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
          <button type="button" onClick={close} style={{ padding: '11px 16px', borderRadius: '10px', border: 'none', background: '#22c55e', color: '#fff', fontSize: '14px', fontWeight: 800, cursor: 'pointer' }}>Got it</button>
          <button type="button" onClick={() => { close(); router.push(WHATS_NEW_PATH); }} style={{ padding: '11px 16px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '14px', fontWeight: 800, cursor: 'pointer' }}>See all changes</button>
        </div>
      </div>
    </div>
  );
}

/** The small red dot on the More tab. */
export function WhatsNewDot() {
  const { unseenPage } = useWhatsNew();
  if (!unseenPage) return null;
  return <span aria-label="What's new" style={{ position: 'absolute', top: '2px', right: 'calc(50% - 16px)', width: '9px', height: '9px', borderRadius: '50%', background: '#ef4444' }} />;
}

function NoteRow({ n }: { n: ReleaseNote }) {
  const fix = n.kind === 'fix';
  return (
    <li style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px', alignItems: 'start', fontSize: '14px', lineHeight: 1.45 }}>
      <span style={{ fontSize: '11px', fontWeight: 800, borderRadius: '6px', padding: '2px 7px', marginTop: '1px', whiteSpace: 'nowrap', background: fix ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)', color: fix ? '#b45309' : '#15803d' }}>
        {fix ? 'Fixed' : 'New'}
      </span>
      <span style={{ minWidth: 0, color: 'var(--text-primary)' }}>
        {n.text}
        <span style={{ display: 'block', fontSize: '12.5px', color: 'var(--text-muted)' }}>{n.where}</span>
      </span>
    </li>
  );
}

/** One release's card on the What's new page. */
export function ReleaseCard({ release, fresh }: { release: Release; fresh: boolean }) {
  const [openBooks, setOpenBooks] = useState(false);
  const main = release.notes.filter(n => !isBooksOnly(n));
  const books = release.notes.filter(isBooksOnly);
  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: '16px', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{release.number}</span>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{releaseDayLabel(release.date)}</span>
        {fresh && <span style={{ fontSize: '11px', fontWeight: 800, background: '#ef4444', color: '#fff', borderRadius: '999px', padding: '2px 8px' }}>New for you</span>}
      </div>
      {main.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {main.map((n, i) => <NoteRow key={i} n={n} />)}
        </ul>
      )}
      {books.length > 0 && (
        <div>
          <button type="button" onClick={() => setOpenBooks(o => !o)} aria-expanded={openBooks} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '13.5px', fontWeight: 700, color: 'var(--text-muted)', textAlign: 'left' }}>
            <span aria-hidden style={{ display: 'inline-block', width: '12px', transform: openBooks ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>▾</span>
            Books: {books.length} behind-the-scenes change{books.length === 1 ? '' : 's'}
          </button>
          {openBooks && (
            <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {books.map((n, i) => <NoteRow key={i} n={n} />)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
