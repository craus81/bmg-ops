'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { createClient } from '@/lib/supabase-browser';
import { downloadCsv } from '@/lib/csv';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { flashNote } from '@/lib/focus-note';

interface AtRiskRow {
  id: string;
  netsuite_id: string;
  company_name: string;
  entity_id: string | null;
  last_year_spend: number;
  ytd_spend: number;
  total_spend: number;
  last_order_date: string | null;
  days_quiet: number | null;
  pace: number;
  severity: 'critical' | 'watch';
  account_owner_id: string | null;
  account_owner_name: string | null;
  internal_notes: string | null;
  at_risk_dismissed_at: string | null;
}

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function AtRiskReportPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isAdmin, isSales, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [rows, setRows] = useState<AtRiskRow[]>([]);
  const [scanned, setScanned] = useState(0);
  const [minSpend, setMinSpend] = useState('10000');
  const [quietDays, setQuietDays] = useState('60');
  const [showDismissed, setShowDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reps assignable as account owners (admin + sales, approved).
  const [reps, setReps] = useState<{ id: string; name: string }[]>([]);

  // Per-row note editor state
  const [noteOpenId, setNoteOpenId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSavedValue, setNoteSavedValue] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);

  // Deep link (mentions inbox): ?id=<customer id> opens that row's note and
  // scrolls to it once the report has loaded. One-shot — re-runs of the
  // report (filter changes) don't re-trigger it.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (loading || deepLinked.current) return;
    const id = searchParams.get('id');
    if (!id) return;
    deepLinked.current = true;
    const row = rows.find(r => r.id === id);
    if (!row) return; // e.g. dismissed rows aren't in the default view
    setNoteOpenId(row.id);
    setNoteDraft(row.internal_notes || '');
    setNoteSavedValue(row.internal_notes || '');
    flashNote(`atrisk-${id}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: fire once after first load
  }, [loading]);

  const run = useCallback(async (ms: string, qd: string, incDismissed: boolean) => {
    setLoading(true);
    setError(null);
    setNoteOpenId(null);
    try {
      const res = await fetch(`/api/reports/at-risk?minSpend=${encodeURIComponent(ms)}&quietDays=${encodeURIComponent(qd)}${incDismissed ? '&includeDismissed=1' : ''}`);
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Report failed');
      else { setRows(data.flagged || []); setScanned(data.scanned || 0); }
    } catch (e: any) {
      setError(e.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    run(minSpend, quietDays, showDismissed);
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, role, roles')
        .eq('status', 'approved')
        .order('full_name');
      setReps((data || [])
        .filter((p: any) => {
          const roleList: string[] = p.roles?.length ? p.roles : [p.role];
          return roleList.includes('admin') || roleList.includes('super_admin') || roleList.includes('sales');
        })
        .map((p: any) => ({ id: p.id, name: p.full_name || 'Unknown' })));
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once after auth resolves
  }, [authLoading, isAdmin, isSales, router]);

  const assignOwner = async (row: AtRiskRow, ownerId: string) => {
    const { error: err } = await supabase
      .from('customers')
      .update({ account_owner_id: ownerId || null })
      .eq('id', row.id);
    if (err) { await dialog.alert(`Assign failed: ${err.message}`); return; }
    const ownerName = reps.find(rp => rp.id === ownerId)?.name || null;
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, account_owner_id: ownerId || null, account_owner_name: ownerName } : r));
  };

  const toggleNote = (row: AtRiskRow) => {
    if (noteOpenId === row.id) { setNoteOpenId(null); return; }
    setNoteOpenId(row.id);
    setNoteDraft(row.internal_notes || '');
    setNoteSavedValue(row.internal_notes || '');
  };

  const saveNote = async (row: AtRiskRow) => {
    setNoteSaving(true);
    const value = noteDraft.trim() || null;
    const { error: err } = await supabase
      .from('customers')
      .update({ internal_notes: value })
      .eq('id', row.id);
    setNoteSaving(false);
    if (err) { await dialog.alert(`Note save failed: ${err.message}`); return; }
    if ((value || '') !== noteSavedValue) {
      reportMentions({
        text: value || '',
        previousText: noteSavedValue,
        sourceType: 'customer_note',
        sourceId: row.id,
        contextLabel: `At-risk account — ${row.company_name}`,
        contextUrl: `/admin/reports/at-risk?id=${row.id}`,
      });
    }
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, internal_notes: value } : r));
    setNoteOpenId(null);
  };

  const dismissRow = async (row: AtRiskRow) => {
    if (!(await dialog.confirm(`Dismiss ${row.company_name} from the at-risk list? It stays out of this report, the dashboard count, and the daily alert until restored.`, { confirmLabel: 'Dismiss' }))) return;
    const { error: err } = await supabase
      .from('customers')
      .update({ at_risk_dismissed_at: new Date().toISOString(), at_risk_dismissed_by: user?.id || null })
      .eq('id', row.id);
    if (err) { await dialog.alert(`Dismiss failed: ${err.message}`); return; }
    if (showDismissed) {
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, at_risk_dismissed_at: new Date().toISOString() } : r));
    } else {
      setRows(prev => prev.filter(r => r.id !== row.id));
    }
  };

  const restoreRow = async (row: AtRiskRow) => {
    const { error: err } = await supabase
      .from('customers')
      .update({ at_risk_dismissed_at: null, at_risk_dismissed_by: null })
      .eq('id', row.id);
    if (err) { await dialog.alert(`Restore failed: ${err.message}`); return; }
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, at_risk_dismissed_at: null } : r));
  };

  const exportCsv = () => {
    downloadCsv(
      `at-risk-accounts-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Customer', 'Entity ID', 'Severity', 'Last Year Spend', 'YTD Spend', 'Pace %', 'Last Order', 'Days Quiet', 'All-Time Spend', 'Account Owner', 'Notes', 'Dismissed'],
      rows.map(r => [
        r.company_name, r.entity_id, r.severity, r.last_year_spend, r.ytd_spend,
        Math.round(r.pace * 100), r.last_order_date, r.days_quiet, r.total_spend, r.account_owner_name,
        r.internal_notes, r.at_risk_dismissed_at ? 'yes' : '',
      ]),
    );
  };

  const active = rows.filter(r => !r.at_risk_dismissed_at);
  const critical = active.filter(r => r.severity === 'critical');
  const revenueAtRisk = active.reduce((s, r) => s + r.last_year_spend, 0);

  const cell: React.CSSProperties = { padding: '7px 8px', borderBottom: '1px solid var(--border)', fontSize: '12px' };
  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', width: '110px',
  };

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>At-Risk Accounts</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Customers who spent real money last year and have gone quiet — behind pace and no recent orders. A daily check alerts admins and the account&apos;s rep when a new one appears.
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Min last-year spend ($)</div>
          <input style={inputStyle} inputMode="numeric" value={minSpend} onChange={e => setMinSpend(e.target.value)} />
        </div>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Quiet for at least (days)</div>
          <input style={inputStyle} inputMode="numeric" value={quietDays} onChange={e => setQuietDays(e.target.value)} />
        </div>
        <button onClick={() => run(minSpend, quietDays, showDismissed)} disabled={loading} style={{ padding: '9px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>
          {loading ? 'Running…' : 'Run'}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', cursor: 'pointer', paddingBottom: '9px' }}>
          <input type="checkbox" checked={showDismissed} onChange={e => { setShowDismissed(e.target.checked); run(minSpend, quietDays, e.target.checked); }} />
          Show dismissed
        </label>
        {rows.length > 0 && (
          <button onClick={exportCsv} style={{ padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
            Export CSV
          </button>
        )}
      </div>

      {error && <div style={{ padding: '12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', marginBottom: '14px' }}>{error}</div>}

      {/* Summary tiles */}
      {!loading && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '14px' }}>
          {[
            { label: 'At risk', value: String(active.length), color: active.length > 0 ? '#fbbf24' : '#22c55e' },
            { label: 'Critical (zero / <20% pace)', value: String(critical.length), color: critical.length > 0 ? '#ef4444' : '#22c55e' },
            { label: 'Last-year revenue at risk', value: fmtMoney(revenueAtRisk), color: '#f472b6' },
            { label: 'Accounts scanned', value: String(scanned), color: 'var(--text-muted)' },
          ].map(t => (
            <div key={t.label} style={{ padding: '12px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t.label}</div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: t.color, marginTop: '2px' }}>{t.value}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          No at-risk accounts with these thresholds — nice.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                <th style={{ ...cell, textAlign: 'left' }}>Customer</th>
                <th style={{ ...cell, textAlign: 'center' }}>Severity</th>
                <th style={{ ...cell, textAlign: 'right' }}>Last Year</th>
                <th style={{ ...cell, textAlign: 'right' }}>YTD</th>
                <th style={{ ...cell, textAlign: 'right' }}>Pace</th>
                <th style={{ ...cell, textAlign: 'right' }}>Last Order</th>
                <th style={{ ...cell, textAlign: 'right' }}>Quiet</th>
                <th style={{ ...cell, textAlign: 'left' }}>Owner</th>
                <th style={{ ...cell, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <React.Fragment key={r.id}>
                <tr id={`atrisk-${r.id}`} style={{ opacity: r.at_risk_dismissed_at ? 0.5 : 1 }}>
                  <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {r.company_name}
                    {r.entity_id && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '6px', fontSize: '10px' }}>{r.entity_id}</span>}
                    {r.at_risk_dismissed_at && <span style={{ fontSize: '9px', fontWeight: 700, color: '#94a3b8', marginLeft: '6px' }}>dismissed</span>}
                  </td>
                  <td style={{ ...cell, textAlign: 'center' }}>
                    <span style={{
                      fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', textTransform: 'uppercase',
                      background: r.severity === 'critical' ? 'rgba(239,68,68,0.12)' : 'rgba(251,191,36,0.12)',
                      color: r.severity === 'critical' ? '#ef4444' : '#fbbf24',
                    }}>{r.severity}</span>
                  </td>
                  <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(r.last_year_spend)}</td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 700, color: r.ytd_spend === 0 ? '#ef4444' : 'var(--text-primary)' }}>{fmtMoney(r.ytd_spend)}</td>
                  <td style={{ ...cell, textAlign: 'right', color: r.pace < 0.2 ? '#ef4444' : '#fbbf24' }}>{Math.round(r.pace * 100)}%</td>
                  <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{r.last_order_date ? new Date(r.last_order_date).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }) : 'never'}</td>
                  <td style={{ ...cell, textAlign: 'right', color: (r.days_quiet ?? 999) >= 90 ? '#ef4444' : 'var(--text-secondary)' }}>{r.days_quiet != null ? `${r.days_quiet}d` : '—'}</td>
                  <td style={{ ...cell }}>
                    <select
                      value={r.account_owner_id || ''}
                      onChange={e => assignOwner(r, e.target.value)}
                      style={{
                        padding: '4px 6px', borderRadius: '6px', fontSize: '11px', maxWidth: '140px', cursor: 'pointer',
                        border: '1px solid var(--border)', background: 'var(--input-bg)',
                        color: r.account_owner_id ? 'var(--text-primary)' : 'var(--text-muted)',
                      }}
                    >
                      <option value="">unassigned</option>
                      {reps.map(rp => <option key={rp.id} value={rp.id}>{rp.name}</option>)}
                    </select>
                  </td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => toggleNote(r)}
                      title={r.internal_notes ? r.internal_notes : 'Add a note'}
                      style={{
                        padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', marginRight: '4px',
                        background: r.internal_notes ? 'rgba(96,165,250,0.12)' : 'var(--subtle-bg)',
                        border: `1px solid ${r.internal_notes ? 'rgba(96,165,250,0.35)' : 'var(--border)'}`,
                        color: r.internal_notes ? '#60a5fa' : 'var(--text-muted)',
                      }}
                    >📝{r.internal_notes ? '' : ' +'}</button>
                    {r.at_risk_dismissed_at ? (
                      <button onClick={() => restoreRow(r)} style={{ padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e' }}>
                        Restore
                      </button>
                    ) : (
                      <button onClick={() => dismissRow(r)} title="Remove from the at-risk list until restored" style={{ padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                        Dismiss
                      </button>
                    )}
                  </td>
                </tr>
                {noteOpenId === r.id && (
                  <tr>
                    <td colSpan={9} style={{ ...cell, background: 'var(--subtle-bg)' }}>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end', padding: '4px 0' }}>
                        <MentionTextArea
                          value={noteDraft}
                          onChange={setNoteDraft}
                          placeholder={`Notes about ${r.company_name} — @ tags a teammate`}
                          rows={2}
                          style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '12px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)' }}
                        />
                        <button onClick={() => saveNote(r)} disabled={noteSaving} style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--orange)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                          {noteSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => setNoteOpenId(null)} style={{ padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--subtle-bg)', color: 'var(--text-muted)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
