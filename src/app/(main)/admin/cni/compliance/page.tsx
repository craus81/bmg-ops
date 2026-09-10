'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Installer compliance (R6-8). Every company and installer with their
 * computed eligibility, worst first.
 *
 * The distinction the page exists to make visible: a certificate with NO
 * expiry date is not "fine" — it is unverifiable, and it reads differently
 * from a date that has passed and from no certificate at all. The headline
 * says how many subjects are in that unverifiable state, because that
 * number is the honest answer to "how many are we actually sure about".
 */

interface Requirement { key: string; label: string; met: boolean; detail: string | null }
interface Status {
  subjectType: 'company' | 'installer';
  subjectId: string;
  name: string;
  eligible: boolean;
  state: 'compliant' | 'expiring' | 'lapsed' | 'incomplete';
  requirements: Requirement[];
  blocking: string[];
  insuranceExpiry: string | null;
  daysToExpiry: number | null;
}
interface Overview {
  companies: Status[];
  installers: Status[];
  totals: {
    companies: number; companiesEligible: number; companiesExpiring: number;
    installers: number; installersEligible: number; undatedCertificates: number;
  };
  today: string;
}

const STATE_META: Record<Status['state'], { label: string; color: string }> = {
  compliant: { label: 'Eligible', color: '#22c55e' },
  expiring: { label: 'Expiring soon', color: '#f59e0b' },
  lapsed: { label: 'Lapsed', color: '#ef4444' },
  incomplete: { label: 'Incomplete', color: '#a78bfa' },
};

export default function CniCompliancePage() {
  const { isAdmin, hasFeature, loading: authLoading } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClean, setShowClean] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/cni/compliance');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setData(json as Overview);
    } catch (e: any) {
      setError(e.message || 'Failed');
      setData(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasFeature('cni_admin')) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasFeature identity changes per render; auth state deps cover it
  }, [authLoading, isAdmin, router, load]);

  const tile = (label: string, value: string, color: string, sub: string) => (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', minWidth: '150px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, color, marginTop: '2px' }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>
    </div>
  );

  const section = (title: string, rows: Status[], hrefFor: (s: Status) => string) => {
    const shown = showClean ? rows : rows.filter(r => r.state !== 'compliant');
    return (
      <div style={{ marginBottom: '18px' }}>
        <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '0 0 8px' }}>
          {title} <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: '12px' }}>· {shown.length} of {rows.length}</span>
        </h2>
        {shown.length === 0 ? (
          <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
            {rows.length === 0 ? 'None on file.' : 'Everything here is eligible and outside the warning window.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {shown.map(s => {
              const m = STATE_META[s.state];
              return (
                <div key={`${s.subjectType}-${s.subjectId}`} style={{
                  border: `1px solid ${s.eligible ? 'var(--border)' : m.color}`,
                  borderRadius: '12px', padding: '11px 14px', background: 'var(--card)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <Link href={hrefFor(s)} style={{ fontWeight: 800, fontSize: '13.5px', color: 'var(--accent, #2563eb)', textDecoration: 'none' }}>
                      {s.name}
                    </Link>
                    <span style={{
                      fontSize: '10.5px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px',
                      color: m.color, background: `${m.color}1f`, padding: '3px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
                    }}>{m.label}</span>
                  </div>
                  {s.insuranceExpiry && (
                    <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                      Insurance expiry {s.insuranceExpiry}
                      {s.daysToExpiry != null && (
                        <> · {s.daysToExpiry < 0 ? `${Math.abs(s.daysToExpiry)} days ago` : `in ${s.daysToExpiry} days`}</>
                      )}
                    </div>
                  )}
                  {s.requirements.filter(r => !r.met).length > 0 && (
                    <ul style={{ margin: '6px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      {s.requirements.filter(r => !r.met).map(r => (
                        <li key={r.key}><strong style={{ color: 'var(--text-primary)' }}>{r.label}</strong> — {r.detail}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  if (authLoading || !hasFeature('cni_admin')) return null;

  return (
    <div style={{ maxWidth: '900px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Installer Compliance</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Who is eligible for work right now: documents on file, agreements accepted, insurance unexpired.
        Computed live — nothing here is a stored flag that can go stale overnight.
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {data && !loading && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' }}>
            {tile('Companies eligible',
              `${data.totals.companiesEligible}/${data.totals.companies}`,
              data.totals.companiesEligible === data.totals.companies ? '#22c55e' : '#ef4444',
              `${data.totals.companiesExpiring} inside the warning window`)}
            {tile('Installers eligible',
              `${data.totals.installersEligible}/${data.totals.installers}`,
              data.totals.installersEligible === data.totals.installers ? '#22c55e' : '#ef4444',
              'documents + agreements + insurance')}
            {tile('Unverifiable',
              String(data.totals.undatedCertificates),
              data.totals.undatedCertificates > 0 ? '#a78bfa' : '#22c55e',
              'certificate on file, no expiry date')}
          </div>
          {data.totals.undatedCertificates > 0 && (
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '14px' }}>
              A certificate with no expiry date recorded is not counted as compliant. Nobody can tell whether it covers today —
              entering the date on the record is the whole fix.
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
            <button onClick={() => setShowClean(v => !v)} style={{
              padding: '7px 13px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
              border: '1px solid var(--border)', background: showClean ? 'var(--card)' : 'transparent', color: 'var(--text-primary)',
            }}>{showClean ? '✓ Showing everyone' : 'Show everyone'}</button>
            <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>Worst first. As of {data.today}.</span>
          </div>

          {section('Companies', data.companies, s => `/admin/cni/companies/${s.subjectId}`)}
          {section('Installers', data.installers, s => `/admin/cni/installers/${s.subjectId}`)}

          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            The daily CNI sweep warns each subject once at 30, 14, 7 and 3 days before expiry and again on the day it lapses —
            not once a morning. A renewed certificate re-arms the whole ladder on its own, because the warnings are keyed to
            the expiry date they were about. Assigning work to a non-compliant company is possible but is recorded as an
            override with a written reason.
          </div>
        </>
      )}
    </div>
  );
}
