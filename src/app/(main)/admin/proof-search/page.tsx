'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import DropboxProofSearch from '@/components/DropboxProofSearch';
import EmailProofSearch from '@/components/EmailProofSearch';

// Global proof search — a single page where anyone hunting for existing
// artwork can type a customer name, part number, or filename and pull
// matching files, without first opening a specific job / quote / prospect
// record. Two sources: the Dropbox archive and your Gmail attachments,
// picked via the toggle (one at a time so the panels don't stack).
type Source = 'dropbox' | 'email';
const SOURCES: { id: Source; label: string }[] = [
  { id: 'dropbox', label: 'Dropbox' },
  { id: 'email', label: 'Email' },
];

export default function ProofSearchPage() {
  const router = useRouter();
  const { isAdmin, isSales, isGraphicsProduction, user } = useAuth();
  const hasAccess = isAdmin || isSales || isGraphicsProduction;
  const [source, setSource] = useState<Source>('dropbox');

  useEffect(() => {
    if (!user) return;
    if (!hasAccess) router.push('/home');
  }, [user, hasAccess, router]);

  if (!user) return null;
  if (!hasAccess) return null;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Proof Search</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
          Find proof artwork by customer, part number, or filename — across the Dropbox archive or your Gmail attachments — without walking the folder tree.
        </div>
      </div>

      {/* Source toggle — one source at a time so the two search panels don't stack. */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: '12px', marginBottom: '12px',
      }}>
        {SOURCES.map((s) => (
          <button
            key={s.id}
            onClick={() => setSource(s.id)}
            style={{
              flex: 1, padding: '10px 8px', borderRadius: '10px',
              fontSize: '13px', fontWeight: 700, textAlign: 'center',
              background: source === s.id ? 'var(--tab-active-bg)' : 'transparent',
              border: source === s.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
              color: source === s.id ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
          >{s.label}</button>
        ))}
      </div>

      {source === 'dropbox' ? <DropboxProofSearch /> : <EmailProofSearch />}
    </div>
  );
}
