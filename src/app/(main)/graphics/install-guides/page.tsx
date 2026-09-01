'use client';

/**
 * Install Guides — dimensioned placement guides for CNI installers.
 *
 * Lists every guide and creates new ones. The real work happens in the
 * editor (/graphics/install-guides/[id]): upload 1:20 template/proof
 * pages, draw dimension lines that read in actual vehicle inches, and
 * export the branded PDF guide.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { theme } from '@/lib/theme';
import { defaultGuideSections, type GuidePage, type InstallGuide } from '@/lib/install-guide';

export default function InstallGuidesPage() {
  const { user, isAdmin, isSales, isGraphicsProduction, hasRole, loading: authLoading } = useAuth();
  // super_admin included explicitly — isAdmin tests only the literal
  // 'admin' role (Stage 6 finding; migration 248 fixes the matching RLS).
  const hasAccess = isAdmin || isSales || isGraphicsProduction || hasRole('super_admin');
  const router = useRouter();
  const dialog = useDialog();
  const supabase = createClient();

  const [guides, setGuides] = useState<InstallGuide[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !hasAccess) return;
    (async () => {
      const { data, error: err } = await supabase
        .from('install_guides')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(200);
      if (err) setError(err.message);
      else setGuides((data || []) as InstallGuide[]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [authLoading, hasAccess]);

  const createGuide = async () => {
    setCreating(true);
    const { data, error: err } = await supabase
      .from('install_guides')
      .insert({
        title: '',
        sections: defaultGuideSections(),
        pages: [],
        created_by: user?.id || null,
      })
      .select('id')
      .single();
    setCreating(false);
    if (err || !data) {
      await dialog.alert(err?.message || 'Failed to create the guide.', { title: 'Create failed' });
      return;
    }
    router.push(`/graphics/install-guides/${data.id}`);
  };

  const deleteGuide = async (g: InstallGuide) => {
    const ok = await dialog.confirm(
      `Delete "${g.title || 'Untitled guide'}"? Its pages and dimensions are removed permanently.`,
      { destructive: true, confirmLabel: 'Delete' },
    );
    if (!ok) return;
    const { error: err } = await supabase.from('install_guides').delete().eq('id', g.id);
    if (err) {
      await dialog.alert(err.message, { title: 'Delete failed' });
      return;
    }
    // Best-effort storage cleanup (page rasters + stored source PDFs);
    // orphans are harmless.
    const paths = [
      ...new Set(
        (g.pages || []).flatMap((p: GuidePage) => [p.image_path, p.source_pdf_path || '']).filter(Boolean),
      ),
    ];
    if (paths.length) storage.from('vehicle-templates').remove(paths).catch(() => {});
    setGuides(prev => prev.filter(x => x.id !== g.id));
  };

  if (authLoading || (hasAccess && loading)) {
    return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;
  }
  if (!hasAccess) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
        You don&apos;t have access to Install Guides.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <div style={{ fontSize: '22px', fontWeight: 800 }}>Install Guides</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Dimensioned placement guides for CNI installers — built from 1:20 scale templates
          </div>
        </div>
        <button
          onClick={createGuide}
          disabled={creating}
          style={{
            padding: '8px 14px', borderRadius: '10px', background: theme.orange, color: '#fff',
            fontWeight: 800, fontSize: '12px', border: 'none', cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(238,49,32,0.3)', opacity: creating ? 0.6 : 1,
          }}
        >
          {creating ? 'Creating…' : '+ New Guide'}
        </button>
      </div>

      {error && (
        <div style={{
          background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)',
          borderRadius: '10px', padding: '10px 14px', fontSize: '12px', marginBottom: '12px', whiteSpace: 'pre-wrap',
        }}>
          {/relation .* does not exist/i.test(error)
            ? `${error}\n\nThe install_guides table is missing — pending migrations haven't been applied. Run "npm run migrate".`
            : error}
        </div>
      )}

      {guides.length === 0 && !error ? (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
          padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px',
        }}>
          No install guides yet. Create one, upload a 1:20 scale template with the graphics placed on it,
          and draw dimension lines so installers know exactly where everything goes.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '8px' }}>
          {guides.map(g => (
            <div
              key={g.id}
              onClick={() => router.push(`/graphics/install-guides/${g.id}`)}
              style={{
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
                padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '14px' }}>
                  {g.title || 'Untitled guide'}
                  {g.customer_name && (
                    <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}> — {g.customer_name}</span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {[
                    g.vehicle_desc,
                    `${(g.pages || []).length} page${(g.pages || []).length === 1 ? '' : 's'}`,
                    `${(g.pages || []).reduce((n, p) => n + (p.dims?.length || 0), 0)} dimensions`,
                    `updated ${new Date(g.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
                  ].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button
                onClick={e => { e.stopPropagation(); deleteGuide(g); }}
                style={{
                  padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                  background: 'transparent', border: '1px solid var(--error-border)', color: 'var(--error)', cursor: 'pointer',
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
