'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { useFileDownload } from '@/lib/use-file-download';
import { BACKUPS_LISTED, fileSize, holdsWords, tookWords } from '@/lib/books/backup-words';
import type { BackupRecord, BackupStatus, BackupsView } from '@/lib/books/backups';

/**
 * Books → Backups (docs/books.md "Backups").
 *
 * Each night at 2:11 AM Central FleetSuite copies its books into one zip in
 * BMG's private file storage: every table as a CSV file, the journal as a
 * workbook to read, and a manifest. It reads the copy back and checks its
 * journal against the books before counting it as good. Every backup, how
 * it went and why one failed; a super admin downloads one or makes one now.
 * Open to whoever opens the books.
 */

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GREY = '#94a3b8';

const when = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});

const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};
const card = (picked: boolean): React.CSSProperties => ({
  border: `1px solid ${picked ? 'var(--text-secondary)' : 'var(--border)'}`, borderRadius: '8px', padding: '10px 12px', background: 'var(--card)',
});
const heading: React.CSSProperties = { fontSize: '14px', fontWeight: 800, marginBottom: '6px' };
const muted: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)' };

const STATUSES: Record<BackupStatus, { label: string; color: string }> = {
  made: { label: 'Made', color: GREEN },
  failed: { label: "Didn't work", color: RED },
  running: { label: 'Running', color: GREY },
  stopped: { label: 'Stopped', color: RED },
};

export default function BooksBackupsPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  // Making a backup and downloading one are the owner's; the bookkeeper and the CPA see the list.
  const canBackUp = booksAllows(booksAccess(hasRole), 'owner');
  const [data, setData] = useState<BackupsView | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [made, setMade] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const file = useFileDownload(setDownloadError);
  /** Whether the notification's backup still needs scrolling to, once the list is read. */
  const toPicked = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/backups');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || "Couldn't read the backups");
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // The daily check's notification opens the backup that didn't work.
    const backup = new URLSearchParams(window.location.search).get('backup');
    if (backup) { setPicked(backup); toPicked.current = true; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  useEffect(() => {
    if (!data || !toPicked.current || !picked) return;
    toPicked.current = false;
    document.getElementById(`backup-${picked}`)?.scrollIntoView({ block: 'center' });
  }, [data, picked]);

  // A backup running (the night's, or one someone else started) shows how it went once it's done.
  const anyRunning = !!data?.backups.some((b) => b.status === 'running');
  useEffect(() => {
    if (!anyRunning || running) return;
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [anyRunning, running, load]);

  const backUp = async () => {
    setRunning(true);
    setRunError('');
    setMade(null);
    try {
      const res = await apiFetch('/api/admin/books/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'back_up' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `The backup failed (${res.status})`);
      setMade(json.id ?? null);
      setPicked(json.id ?? null);
    } catch (e: any) {
      setRunError(e?.message || "The backup didn't work");
    }
    await load();
    setRunning(false);
  };

  const download = async (b: BackupRecord) => {
    setDownloadError('');
    setDownloading(b.id);
    await file.download(`/api/admin/books/backups/download?id=${b.id}`, b.fileName || 'FleetSuite books backup.zip');
    setDownloading(null);
  };

  const madeOne = made && data?.backups.find((b) => b.id === made);

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Backups</div>
        <div style={muted}>
          Each night FleetSuite copies its books to BMG&apos;s private file storage and checks the copy before keeping it.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              A backup is one zip: every table of the books as a CSV file, which is what a restore loads, the journal as an Excel
              workbook to read (trial balance, chart of accounts, every entry), and a list of what each file holds. FleetSuite reads
              each one back and checks that its journal adds up, account by account, to what the books held when it began; only then
              is it counted as good. Every backup is kept. The daily check tells the super admins when the night&apos;s backup
              didn&apos;t work or none was made in a day. FleetSuite&apos;s code says how to restore one (docs/books.md
              &quot;Backups&quot;).
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href="/admin/books/months" style={{ color: 'var(--text-secondary)' }}>Months</Link>
          {' · '}
          <Link href="/admin/books/netsuite-feed" style={{ color: 'var(--text-secondary)' }}>NetSuite feed</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {data.storageProblem && <div style={banner(RED)}>{data.storageProblem}</div>}
          {data.due && (
            <div style={banner(AMBER)}>
              {data.lastMade ? `No good backup since ${when(data.lastMade.startedAt)}.` : 'No good backup has been made yet.'}
              {canBackUp && !data.storageProblem ? ' Back up now makes one.' : ''}
            </div>
          )}
          {data.lastMade && !data.due && (
            <div style={banner(GREEN)}>
              The last good backup is from {when(data.lastMade.startedAt)}{data.lastMade.bytes !== null ? `, ${fileSize(data.lastMade.bytes)}` : ''}.
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' }}>
            {canBackUp && (
              <button onClick={backUp} disabled={running || !!data.storageProblem} style={act(GREEN, !running && !data.storageProblem)}>
                {running ? 'Backing up…' : 'Back up now'}
              </button>
            )}
            <span style={muted}>The next nightly backup is {when(data.next)}.</span>
          </div>
          {running && <div style={{ ...muted, marginBottom: '10px' }}>Stay on this page until it says how it went.</div>}
          {runError && <div style={banner(RED)}>{runError}</div>}
          {madeOne && <div style={banner(GREEN)}>Backed up and checked: {madeOne.fileName}.</div>}
          {downloadError && <div style={banner(RED)}>{downloadError}</div>}

          <div style={{ marginTop: '14px' }}>
            <div style={heading}>Every backup</div>
            {!data.backups.length && (
              <div style={banner(GREY)}>None yet. The first one is made tonight{canBackUp ? ', or press Back up now' : ''}.</div>
            )}
            {data.backups.length >= BACKUPS_LISTED && <div style={banner(GREY)}>These are the newest {data.backups.length}.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {data.backups.map((b) => {
                const s = STATUSES[b.status];
                const holds = holdsWords(b);
                return (
                  <div key={b.id} id={`backup-${b.id}`} style={card(picked === b.id)}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '14px', fontWeight: 800 }}>{when(b.startedAt)}</span>
                      <span style={chip(s.color)}>{s.label}</span>
                      <span style={muted}>{b.how === 'nightly' ? 'Nightly' : `By hand${b.askedBy ? `, ${b.askedBy}` : ''}`}</span>
                      {canBackUp && b.status === 'made' && b.file && (
                        <button
                          onClick={() => download(b)}
                          disabled={!!downloading}
                          style={{ ...link, marginLeft: 'auto', opacity: downloading && downloading !== b.id ? 0.5 : 1 }}
                        >
                          {downloading === b.id ? 'Getting it…' : file.ready(`/api/admin/books/backups/download?id=${b.id}`) ? '⬇ Tap to save' : '⬇ Download'}
                        </button>
                      )}
                    </div>
                    {b.error && <div style={{ fontSize: '12px', color: RED, marginTop: '2px' }}>{b.error}</div>}
                    {b.status === 'running' && <div style={{ ...muted, marginTop: '2px' }}>Copying the books now.</div>}
                    {(holds || b.finishedAt) && (
                      <div style={{ ...muted, marginTop: '2px' }}>
                        {holds}
                        {holds && b.finishedAt ? ' · ' : ''}
                        {b.finishedAt ? `took ${tookWords(b.startedAt, b.finishedAt)}` : ''}
                      </div>
                    )}
                    {b.status === 'made' && b.fileName && <div style={{ ...muted, marginTop: '2px' }}>{b.fileName}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
