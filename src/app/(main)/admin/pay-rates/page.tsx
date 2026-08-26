'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface PayRate {
  id: string;
  part_number: string;
  rate_per_vehicle: number;
  active: boolean;
  updated_at: string;
}

interface NeedsPricing {
  part_number: string;
  credits: number;
}

export default function PayRatesPage() {
  const router = useRouter();
  const { hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [rates, setRates] = useState<PayRate[]>([]);
  const [needsPricing, setNeedsPricing] = useState<NeedsPricing[]>([]);
  const [noPartCredits, setNoPartCredits] = useState<{ count: number; vins: string[] }>({ count: 0, vins: [] });
  const [cniUnpriced, setCniUnpriced] = useState<{ count: number; jobs: { id: string; label: string }[] }>({ count: 0, jobs: [] });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Per-row edit state, keyed by part_number
  const [edits, setEdits] = useState<Record<string, { rate: string; active: boolean }>>({});
  const [savingPart, setSavingPart] = useState<string | null>(null);

  // Needs-pricing inline rate inputs, keyed by part_number
  const [pricingInputs, setPricingInputs] = useState<Record<string, string>>({});

  // Add-rate row
  const [newPart, setNewPart] = useState('');
  const [newRate, setNewRate] = useState('');
  const [addingRate, setAddingRate] = useState(false);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!hasFeature('payroll')) { router.push('/home'); return; }
    loadRates();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, hasFeature]);

  const authHeaders = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession();
    return {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    };
  };

  const loadRates = async () => {
    setError(null);
    try {
      const res = await fetch('/api/pay-rates', { headers: await authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || 'Failed to load pay rates');
      } else {
        setRates(json.rates || []);
        setNeedsPricing(json.needsPricing || []);
        setNoPartCredits(json.noPartCredits || { count: 0, vins: [] });
        setCniUnpriced(json.cniUnpriced || { count: 0, jobs: [] });
        const initial: Record<string, { rate: string; active: boolean }> = {};
        (json.rates || []).forEach((r: PayRate) => {
          initial[r.part_number] = { rate: Number(r.rate_per_vehicle).toFixed(2), active: r.active };
        });
        setEdits(initial);
      }
    } catch {
      setError('Network error loading pay rates');
    }
    setLoading(false);
  };

  const postRate = async (partNumber: string, ratePerVehicle: number, active?: boolean): Promise<{ ok: boolean; pricedCredits: number; error?: string }> => {
    try {
      const res = await fetch('/api/pay-rates', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ partNumber, ratePerVehicle, ...(active !== undefined ? { active } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, pricedCredits: 0, error: json.error || 'Failed to save rate' };
      return { ok: true, pricedCredits: json.pricedCredits || 0 };
    } catch {
      return { ok: false, pricedCredits: 0, error: 'Network error' };
    }
  };

  const handleSetPricingRate = async (partNumber: string) => {
    const value = parseFloat(pricingInputs[partNumber] || '');
    if (isNaN(value) || value < 0) {
      setError(`Enter a valid rate for ${partNumber}`);
      return;
    }
    setSavingPart(partNumber);
    setError(null);
    setNotice(null);
    const result = await postRate(partNumber, value);
    setSavingPart(null);
    if (!result.ok) {
      setError(result.error || 'Failed to save rate');
      return;
    }
    setNotice(`Rate set for ${partNumber} — ${result.pricedCredits} credit${result.pricedCredits !== 1 ? 's' : ''} priced.`);
    setPricingInputs(prev => ({ ...prev, [partNumber]: '' }));
    await loadRates();
  };

  const handleSaveRow = async (rate: PayRate) => {
    const edit = edits[rate.part_number];
    if (!edit) return;
    const value = parseFloat(edit.rate);
    if (isNaN(value) || value < 0) {
      setError(`Enter a valid rate for ${rate.part_number}`);
      return;
    }
    setSavingPart(rate.part_number);
    setError(null);
    setNotice(null);
    const result = await postRate(rate.part_number, value, edit.active);
    setSavingPart(null);
    if (!result.ok) {
      setError(result.error || 'Failed to save rate');
      return;
    }
    setNotice(
      result.pricedCredits > 0
        ? `Saved ${rate.part_number} — ${result.pricedCredits} credit${result.pricedCredits !== 1 ? 's' : ''} priced.`
        : `Saved ${rate.part_number}.`
    );
    await loadRates();
  };

  const handleAddRate = async () => {
    const part = newPart.trim();
    const value = parseFloat(newRate);
    if (!part || isNaN(value) || value < 0) {
      setError('Enter a part number and a valid rate');
      return;
    }
    setAddingRate(true);
    setError(null);
    setNotice(null);
    const result = await postRate(part, value);
    setAddingRate(false);
    if (!result.ok) {
      setError(result.error || 'Failed to add rate');
      return;
    }
    setNotice(
      result.pricedCredits > 0
        ? `Added ${part} — ${result.pricedCredits} credit${result.pricedCredits !== 1 ? 's' : ''} priced.`
        : `Added ${part}.`
    );
    setNewPart('');
    setNewRate('');
    await loadRates();
  };

  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: '8px', fontSize: '13px',
    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/admin/cni')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            Pay Rates
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Per-vehicle install pay rates for field scans
          </div>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', fontSize: '12px', fontWeight: 600,
          background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)',
        }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', fontSize: '12px', fontWeight: 600,
          background: 'var(--success-bg)', border: '1px solid var(--success-border)', color: 'var(--success)',
        }}>
          {notice}
        </div>
      )}

      {/* Needs pricing banner */}
      {needsPricing.length > 0 && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'color-mix(in srgb, var(--warning) 6%, var(--card))',
          border: '1px solid var(--warning-border)',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
            Needs Pricing
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            Vehicles were scanned before a rate existed. Setting a rate prices their credits.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {needsPricing.map(np => (
              <div key={np.part_number} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '140px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{np.part_number}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>
                    {np.credits} unpriced credit{np.credits !== 1 ? 's' : ''}
                  </span>
                </div>
                <input
                  type="number" step="0.01" min="0" inputMode="decimal"
                  value={pricingInputs[np.part_number] || ''}
                  onChange={e => setPricingInputs(prev => ({ ...prev, [np.part_number]: e.target.value }))}
                  placeholder="$ / vehicle"
                  style={{ ...inputStyle, width: '100px' }}
                />
                <button
                  onClick={() => handleSetPricingRate(np.part_number)}
                  disabled={savingPart === np.part_number}
                  style={{
                    padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                    background: savingPart === np.part_number ? 'var(--text-muted)' : 'var(--orange)',
                    color: '#fff', border: 'none', cursor: 'pointer',
                  }}
                >
                  {savingPart === np.part_number ? 'Saving...' : 'Set Rate'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unpriced pay this screen can't fix — but must not hide */}
      {noPartCredits.count > 0 && (
        <div style={{
          padding: '12px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.3)',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
            {noPartCredits.count} credit{noPartCredits.count !== 1 ? 's' : ''} with no part number
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            These can&apos;t match a rate, so they&apos;d never get priced from here. Fix the part number on the scan (or edit the credit from the job&apos;s Crew &amp; Pay page).
            {noPartCredits.vins.length > 0 && (
              <span style={{ fontFamily: 'monospace', display: 'block', marginTop: '4px' }}>
                VINs: {noPartCredits.vins.join(', ')}{noPartCredits.count > noPartCredits.vins.length ? ` +${noPartCredits.count - noPartCredits.vins.length} more` : ''}
              </span>
            )}
          </div>
        </div>
      )}
      {cniUnpriced.count > 0 && (
        <div style={{
          padding: '12px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.3)',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
            {cniUnpriced.count} unpriced CNI credit{cniUnpriced.count !== 1 ? 's' : ''}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            CNI credits price from the job&apos;s pay-per-vehicle, not these rates — set it on the job:
            <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
              {cniUnpriced.jobs.map(j => (
                <a key={j.id} href={`/admin/cni/jobs/${j.id}`} style={{ fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '6px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa', textDecoration: 'none' }}>
                  {j.label} →
                </a>
              ))}
            </span>
          </div>
        </div>
      )}

      {/* Rates card */}
      <div style={{
        padding: '16px', borderRadius: '14px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Rates
        </div>

        {rates.length === 0 ? (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            No rates configured yet — add one below.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
            {rates.map(r => {
              const edit = edits[r.part_number] || { rate: Number(r.rate_per_vehicle).toFixed(2), active: r.active };
              const dirty = parseFloat(edit.rate) !== Number(r.rate_per_vehicle) || edit.active !== r.active;
              return (
                <div
                  key={r.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
                    padding: '10px 12px', borderRadius: '10px',
                    background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                    opacity: edit.active ? 1 : 0.6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: '140px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{r.part_number}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      ${Number(r.rate_per_vehicle).toFixed(2)} / vehicle
                      {!r.active && ' • inactive'}
                      {' • updated '}{new Date(r.updated_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>$</span>
                    <input
                      type="number" step="0.01" min="0" inputMode="decimal"
                      value={edit.rate}
                      onChange={e => setEdits(prev => ({ ...prev, [r.part_number]: { ...edit, rate: e.target.value } }))}
                      style={{ ...inputStyle, width: '90px' }}
                    />
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={edit.active}
                      onChange={e => setEdits(prev => ({ ...prev, [r.part_number]: { ...edit, active: e.target.checked } }))}
                    />
                    Active
                  </label>
                  <button
                    onClick={() => handleSaveRow(r)}
                    disabled={savingPart === r.part_number || !dirty}
                    style={{
                      padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                      background: savingPart === r.part_number || !dirty ? 'var(--text-muted)' : 'var(--orange)',
                      color: '#fff', border: 'none', cursor: dirty ? 'pointer' : 'default',
                      opacity: dirty ? 1 : 0.6,
                    }}
                  >
                    {savingPart === r.part_number ? 'Saving...' : 'Save'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add rate row */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
          <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', marginBottom: '4px', display: 'block' }}>
            Add Rate
          </label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              value={newPart}
              onChange={e => setNewPart(e.target.value)}
              placeholder="Part number / custom job name"
              style={{ ...inputStyle, flex: 1, minWidth: '160px' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>$</span>
              <input
                type="number" step="0.01" min="0" inputMode="decimal"
                value={newRate}
                onChange={e => setNewRate(e.target.value)}
                placeholder="0.00"
                style={{ ...inputStyle, width: '90px' }}
              />
            </div>
            <button
              onClick={handleAddRate}
              disabled={addingRate || !newPart.trim() || !newRate}
              style={{
                padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: addingRate || !newPart.trim() || !newRate ? 'var(--text-muted)' : 'var(--orange)',
                color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              {addingRate ? 'Adding...' : 'Add'}
            </button>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.5 }}>
            The part number must exactly match the part number or custom job name as it is scanned
            (e.g. &quot;Uhaul Regular&quot;) — rates are matched on that string.
          </div>
        </div>
      </div>

      <div style={{ height: '80px' }} />
    </div>
  );
}
