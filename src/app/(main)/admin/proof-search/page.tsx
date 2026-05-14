'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import DropboxProofSearch from '@/components/DropboxProofSearch';

// Global Dropbox proof search — a single page where anyone hunting for
// existing artwork can type a customer name, part number, or filename
// and pull matching PDFs across every customer folder, without first
// opening a specific job / quote / prospect record.
export default function ProofSearchPage() {
  const router = useRouter();
  const { isAdmin, isSales, isGraphicsProduction, user } = useAuth();
  const hasAccess = isAdmin || isSales || isGraphicsProduction;

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
          Find proof PDFs in Dropbox by customer, part number, or filename without walking the folder tree.
        </div>
      </div>
      <DropboxProofSearch />
    </div>
  );
}
