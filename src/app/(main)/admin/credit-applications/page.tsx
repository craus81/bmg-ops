'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRequireFeature } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { flashNote } from '@/lib/focus-note';
import Link from 'next/link';

/**
 * Credit application review queue (audit Stage 1 CRITICAL: the public form
 * wrote EINs and bank references that nothing in the app ever read, while
 * the applicant was promised an answer in 2-3 business days).
 *
 * All reads/writes go through the requireFeature('credit_applications')
 * routes — migration 237 made the table service-role-only, and the list
 * route deliberately returns summary columns; the full application (EIN,
 * bank reference) is fetched per record as the reviewer opens it.
 */

interface AppRow {
  id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  requested_terms: string | null;
  status: string;
  submitted_at: string;
  reviewed_at: string | null;
  prospect_id: string | null;
}

interface ProspectMatch {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  email: string | null;
  netsuite_id: string | null;
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: 'Pending', color: 'var(--warning)', bg: 'var(--warning-bg)' },
  approved: { label: 'Approved', color: 'var(--success)', bg: 'var(--success-bg)' },
  denied: { label: 'Denied', color: 'var(--error)', bg: 'var(--error-bg)' },
  more_info: { label: 'More info', color: 'var(--info, var(--text-muted))', bg: 'var(--hover, var(--bg))' },
};

const TERMS_LABEL: Record<string, string> = {
  net_15: 'Net 15', net_30: 'Net 30', net_45: 'Net 45', net_60: 'Net 60',
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

function StatusChip({ status }: { status: string }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return (
    <span style={{
      fontSize: '11px', fontWeight: 700, color: m.color, background: m.bg,
      padding: '2px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
    }}>{m.label}</span>
  );
}

/** Field row inside the detail modal. */
function F({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</div>
      <div style={{ fontSize: '13px', color: 'var(--text-body)', marginTop: '2px', overflowWrap: 'anywhere' }}>{value || '—'}</div>
    </div>
  );
}

export default function CreditApplicationsPage() {
  useRequireFeature('credit_applications');
  const dialog = useDialog();

  const [rows, setRows] = useState<AppRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');

  const [detail, setDetail] = useState<any | null>(null);
  const [matches, setMatches] = useState<ProspectMatch[]>([]);
  const [reviewerName, setReviewerName] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notes, setNotes] = useState('');
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/credit-applications');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load applications');
      setRows(data.applications || []);
    } catch (e: any) {
      setError(e.message || 'Failed to load applications');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await apiFetch(`/api/credit-applications/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load application');
      setDetail(data.application);
      setMatches(data.prospectMatches || []);
      setReviewerName(data.reviewerName || null);
      setNotes(data.application.review_notes || '');
    } catch (e: any) {
      await dialog.alert(e.message || 'Failed to load application');
    } finally {
      setDetailLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dialog is stable
  }, []);

  // Deep link: ?app=<id> (notification "New credit application" lands here).
  // One-shot per id, same pattern as the at-risk report.
  const searchParams = useSearchParams();
  const deepLinked = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const id = searchParams.get('app');
    if (!id || deepLinked.current === id) return;
    deepLinked.current = id;
    openDetail(id);
    flashNote(`credit-app-${id}`);
  }, [loading, searchParams, openDetail]);

  const act = async (patch: { status?: string; review_notes?: string; prospectId?: string | null }) => {
    if (!detail) return;
    setActing(true);
    try {
      const res = await apiFetch(`/api/credit-applications/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      setDetail((d: any) => d ? { ...d, ...data.application } : d);
      await load();
    } catch (e: any) {
      await dialog.alert(e.message || 'Update failed');
    } finally {
      setActing(false);
    }
  };

  const decide = async (status: 'approved' | 'denied' | 'more_info') => {
    if ((status === 'denied' || status === 'more_info') && !notes.trim()) {
      await dialog.alert(status === 'denied'
        ? 'Add a note explaining the denial first — it goes in the record.'
        : 'Add a note saying what additional information is needed.');
      return;
    }
    await act({ status, review_notes: notes.trim() || undefined });
  };

  const visible = filter === 'pending' ? rows.filter(r => r.status === 'pending' || r.status === 'more_info') : rows;
  const pendingCount = rows.filter(r => r.status === 'pending').length;

  return (
    <div style={{ padding: '16px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-heading)', margin: 0 }}>Credit Applications</h1>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Net-terms applications from the public form{pendingCount > 0 ? ` — ${pendingCount} pending` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {(['pending', 'all'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
              border: '1px solid var(--border)',
              background: filter === f ? 'var(--accent)' : 'var(--card)',
              color: filter === f ? '#fff' : 'var(--text-body)',
            }}>{f === 'pending' ? 'Needs review' : 'All'}</button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: '14px', padding: '10px 14px', borderRadius: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '13px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '20px 0' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '24px 0', textAlign: 'center' }}>
            {filter === 'pending' ? 'No applications waiting on review.' : 'No credit applications yet.'}
            <div style={{ fontSize: '12px', marginTop: '6px' }}>
              Send a customer the form from their record page ("Credit App"), or share /credit-application directly.
            </div>
          </div>
        ) : visible.map(r => (
          <button key={r.id} id={`credit-app-${r.id}`} onClick={() => openDetail(r.id)} style={{
            textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px',
            padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-heading)' }}>{r.company_name}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {r.contact_name} · {r.contact_email}
                {r.requested_terms ? ` · ${TERMS_LABEL[r.requested_terms] || r.requested_terms}` : ''}
              </div>
            </div>
            <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
              <StatusChip status={r.status} />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{fmtDate(r.submitted_at)}</div>
            </div>
          </button>
        ))}
      </div>

      {(detail || detailLoading) && (
        <div onClick={() => { setDetail(null); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Credit application"
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', width: 'min(760px, 100%)', maxHeight: 'calc(90vh / var(--ts))', overflowY: 'auto' }}>
            {detailLoading || !detail ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '20px' }}>Loading…</div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                  <div>
                    <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-heading)' }}>{detail.company_name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Submitted {fmtDate(detail.submitted_at)}
                      {detail.reviewed_at ? ` · reviewed ${fmtDate(detail.reviewed_at)}${reviewerName ? ` by ${reviewerName}` : ''}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <StatusChip status={detail.status} />
                    <button onClick={() => setDetail(null)} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer', lineHeight: 1 }}>✕</button>
                  </div>
                </div>

                {/* Prospect link */}
                <div style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)' }}>
                  {detail.prospect_id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Linked customer record:</span>
                      <Link href={deepLinks.prospect(detail.prospect_id)} style={{ fontWeight: 700, color: 'var(--accent)' }}>Open record →</Link>
                      <button disabled={acting} onClick={() => act({ prospectId: null })} style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Unlink</button>
                    </div>
                  ) : matches.length > 0 ? (
                    <div style={{ fontSize: '12px' }}>
                      <div style={{ color: 'var(--text-muted)', marginBottom: '6px' }}>
                        Possible customer record match{matches.length !== 1 ? 'es' : ''} — the form is public, so confirm before linking:
                      </div>
                      {matches.map(m => (
                        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '4px 0' }}>
                          <span style={{ fontWeight: 700, color: 'var(--text-body)' }}>{m.company_name || m.contact_name || m.email}</span>
                          {m.email && <span style={{ color: 'var(--text-muted)' }}>{m.email}</span>}
                          <Link href={deepLinks.prospect(m.id)} style={{ color: 'var(--accent)' }}>view</Link>
                          <button disabled={acting} onClick={() => act({ prospectId: m.id })} style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent)', background: 'none', border: '1px solid var(--border)', borderRadius: '6px', padding: '2px 8px', cursor: 'pointer' }}>Link</button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No matching customer record found by email or company name.</div>
                  )}
                </div>

                {/* Application detail */}
                <div style={{ marginTop: '14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
                  <F label="Company" value={detail.company_name} />
                  <F label="DBA" value={detail.dba_name} />
                  <F label="Business type" value={detail.business_type} />
                  <F label="Tax ID (EIN)" value={detail.tax_id} />
                  <F label="Years in business" value={detail.years_in_business} />
                  <F label="Requested terms" value={detail.requested_terms ? (TERMS_LABEL[detail.requested_terms] || detail.requested_terms) : null} />
                  <F label="Est. monthly volume" value={detail.estimated_monthly_volume ? `$${Number(detail.estimated_monthly_volume).toLocaleString()}` : null} />
                  <F label="Contact" value={[detail.contact_name, detail.contact_title].filter(Boolean).join(' — ')} />
                  <F label="Email" value={detail.contact_email} />
                  <F label="Phone" value={detail.contact_phone} />
                  <F label="Address" value={[detail.address, detail.city, detail.state, detail.zip].filter(Boolean).join(', ')} />
                  <F label="AP contact" value={[detail.ap_contact_name, detail.ap_contact_email, detail.ap_contact_phone].filter(Boolean).join(' · ')} />
                  <F label="Bank reference" value={[detail.bank_name, detail.bank_contact, detail.bank_phone, detail.bank_account_type].filter(Boolean).join(' · ')} />
                  {[1, 2, 3].map(n => {
                    const co = detail[`trade_ref_${n}_company`];
                    if (!co) return null;
                    return <F key={n} label={`Trade reference ${n}`} value={[co, detail[`trade_ref_${n}_contact`], detail[`trade_ref_${n}_phone`]].filter(Boolean).join(' · ')} />;
                  })}
                </div>

                {/* Review */}
                <div style={{ marginTop: '16px', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>
                    Review notes {detail.status === 'pending' ? '(required to deny or request more info)' : ''}
                  </div>
                  <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
                    placeholder="e.g. References verified with two suppliers; approved at Net 30."
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-body)', fontSize: '12px', boxSizing: 'border-box', resize: 'vertical' }} />
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                    <button disabled={acting} onClick={() => decide('approved')} style={{ flex: 1, minWidth: '120px', padding: '10px', borderRadius: '8px', border: 'none', background: 'var(--success)', color: '#fff', fontWeight: 800, fontSize: '13px', cursor: 'pointer', opacity: acting ? 0.6 : 1 }}>
                      Approve
                    </button>
                    <button disabled={acting} onClick={() => decide('more_info')} style={{ flex: 1, minWidth: '120px', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-body)', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: acting ? 0.6 : 1 }}>
                      Request more info
                    </button>
                    <button disabled={acting} onClick={() => decide('denied')} style={{ flex: 1, minWidth: '120px', padding: '10px', borderRadius: '8px', border: 'none', background: 'var(--error)', color: '#fff', fontWeight: 800, fontSize: '13px', cursor: 'pointer', opacity: acting ? 0.6 : 1 }}>
                      Deny
                    </button>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
                    The decision is recorded here and on the audit log. Telling the customer is a separate step — use the record page's Email button so it lands on their account history.
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
