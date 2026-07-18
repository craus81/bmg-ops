'use client';

/**
 * Material-usage log on a graphics job card: what vinyl/laminate went into
 * the job and what it cost. Self-contained — loads its own rows, owns its
 * add-modal. `autoPrompt` opens the modal once (used right after a job
 * moves past printing with nothing logged yet).
 */

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';

interface MaterialRow {
  id: string;
  material_name: string;
  category: string;
  quantity_sqft: number | null;
  linear_feet: number | null;
  cost: number | null;
  notes: string | null;
  created_at: string;
}

const CATEGORIES = ['vinyl', 'laminate', 'premask', 'other'] as const;
const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function GraphicsMaterialsCard({ job, autoPrompt, onAutoPromptHandled }: {
  job: { id: string; vinyl_type?: string | null; laminate?: string | null };
  autoPrompt?: boolean;
  onAutoPromptHandled?: () => void;
}) {
  const supabase = createClient();
  const { user } = useAuth();
  const dialog = useDialog();

  const [rows, setRows] = useState<MaterialRow[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'vinyl', sqft: '', linearFeet: '', cost: '', notes: '' });
  const [rateHint, setRateHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('graphics_job_materials')
      .select('id, material_name, category, quantity_sqft, linear_feet, cost, notes, created_at')
      .eq('graphics_job_id', job.id)
      .order('created_at');
    setRows((data as MaterialRow[]) || []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [job.id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (autoPrompt) {
      openModal();
      onAutoPromptHandled?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per prompt
  }, [autoPrompt]);

  const openModal = (category: string = 'vinyl') => {
    setForm({
      name: category === 'laminate' ? (job.laminate || '') : (job.vinyl_type || ''),
      category,
      sqft: '', linearFeet: '', cost: '', notes: '',
    });
    setRateHint(null);
    setShowModal(true);
  };

  // Suggest a cost from the most recent logged entry of the same material
  // that had both sqft and cost — the shop's own history is the price book.
  const updateRateHint = async (name: string, sqft: string) => {
    const sqftNum = parseFloat(sqft);
    if (!name.trim() || !(sqftNum > 0)) { setRateHint(null); return; }
    const { data } = await supabase
      .from('graphics_job_materials')
      .select('quantity_sqft, cost')
      .ilike('material_name', name.trim())
      .not('cost', 'is', null)
      .not('quantity_sqft', 'is', null)
      .gt('quantity_sqft', 0)
      .order('created_at', { ascending: false })
      .limit(1);
    const prior = data?.[0];
    if (prior && Number(prior.quantity_sqft) > 0) {
      const rate = Number(prior.cost) / Number(prior.quantity_sqft);
      setRateHint(`${name.trim()} last logged at ${fmtMoney(rate)}/ft² → ~${fmtMoney(rate * sqftNum)} for ${sqftNum} ft²`);
    } else {
      setRateHint(null);
    }
  };

  const save = async () => {
    if (!form.name.trim()) { await dialog.alert('Material needs a name (e.g. 3M IJ180Cv3).'); return; }
    const sqft = form.sqft.trim() !== '' ? parseFloat(form.sqft) : null;
    const linearFeet = form.linearFeet.trim() !== '' ? parseFloat(form.linearFeet) : null;
    const cost = form.cost.trim() !== '' ? parseFloat(form.cost) : null;
    if (sqft == null && linearFeet == null && cost == null) {
      await dialog.alert('Log at least a quantity (ft² or linear ft) or a cost.');
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('graphics_job_materials').insert({
      graphics_job_id: job.id,
      material_name: form.name.trim(),
      category: form.category,
      quantity_sqft: sqft != null && !isNaN(sqft) ? sqft : null,
      linear_feet: linearFeet != null && !isNaN(linearFeet) ? linearFeet : null,
      cost: cost != null && !isNaN(cost) ? cost : null,
      notes: form.notes.trim() || null,
      logged_by: user?.id || null,
    });
    setSaving(false);
    if (error) { await dialog.alert(`Save failed: ${error.message}`); return; }
    setShowModal(false);
    await load();
  };

  const remove = async (row: MaterialRow) => {
    if (!(await dialog.confirm(`Remove ${row.material_name}${row.cost != null ? ` (${fmtMoney(Number(row.cost))})` : ''} from this job's material log?`, { destructive: true, confirmLabel: 'Remove' }))) return;
    await supabase.from('graphics_job_materials').delete().eq('id', row.id);
    await load();
  };

  const totalCost = rows.reduce((s, r) => s + (r.cost != null ? Number(r.cost) : 0), 0);
  const totalSqft = rows.reduce((s, r) => s + (r.quantity_sqft != null ? Number(r.quantity_sqft) : 0), 0);

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px',
  };

  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>
          Material Used{rows.length > 0 ? ` — ${totalSqft > 0 ? `${totalSqft.toFixed(0)} ft² · ` : ''}${fmtMoney(totalCost)}` : ''}
        </div>
        <button onClick={() => openModal()} style={{ fontSize: '10px', fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: '6px', padding: '3px 8px', cursor: 'pointer' }}>
          + Log Material
        </button>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '6px 0' }}>
          Nothing logged yet — material cost makes this job's profitability visible on the Graphics Costs report.
        </div>
      ) : (
        <div style={{ marginTop: '4px' }}>
          {rows.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', padding: '3px 6px', borderRadius: '4px', background: 'var(--bg)', marginBottom: '2px' }}>
              <span style={{ fontWeight: 700, color: 'var(--text-body)' }}>{r.material_name}</span>
              <span style={{ fontSize: '9px', color: 'var(--text-label)', textTransform: 'uppercase' }}>{r.category}</span>
              <span style={{ flex: 1 }} />
              {r.quantity_sqft != null && <span style={{ color: 'var(--text-label)' }}>{Number(r.quantity_sqft).toFixed(0)} ft²</span>}
              {r.linear_feet != null && <span style={{ color: 'var(--text-label)' }}>{Number(r.linear_feet).toFixed(0)} lin ft</span>}
              <span style={{ fontWeight: 700, color: '#f472b6' }}>{r.cost != null ? fmtMoney(Number(r.cost)) : '—'}</span>
              <button onClick={() => remove(r)} style={{ background: 'transparent', border: 'none', color: '#f87171', fontSize: '12px', cursor: 'pointer', padding: '0 2px' }}>×</button>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }} onClick={() => setShowModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '400px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px' }}>Log Material Used</div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px', marginBottom: '8px' }}>
              <div>
                <div style={labelStyle}>Material</div>
                <input
                  style={inputStyle}
                  value={form.name}
                  onChange={e => { setForm({ ...form, name: e.target.value }); updateRateHint(e.target.value, form.sqft); }}
                  placeholder="e.g. 3M IJ180Cv3"
                />
              </div>
              <div>
                <div style={labelStyle}>Type</div>
                <select style={inputStyle} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '8px' }}>
              <div>
                <div style={labelStyle}>Used (ft²)</div>
                <input
                  style={inputStyle} inputMode="decimal" value={form.sqft}
                  onChange={e => { setForm({ ...form, sqft: e.target.value }); updateRateHint(form.name, e.target.value); }}
                />
              </div>
              <div>
                <div style={labelStyle}>Linear ft</div>
                <input style={inputStyle} inputMode="decimal" value={form.linearFeet} onChange={e => setForm({ ...form, linearFeet: e.target.value })} />
              </div>
              <div>
                <div style={labelStyle}>Cost ($)</div>
                <input style={inputStyle} inputMode="decimal" value={form.cost} onChange={e => setForm({ ...form, cost: e.target.value })} />
              </div>
            </div>
            {rateHint && (
              <div style={{ fontSize: '10px', color: '#60a5fa', marginBottom: '8px' }}>{rateHint}</div>
            )}
            <div style={{ marginBottom: '12px' }}>
              <div style={labelStyle}>Notes</div>
              <input style={inputStyle} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="optional — reprint, waste, etc." />
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowModal(false)} style={{ padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={save} disabled={saving} style={{ padding: '9px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, background: '#34d399', color: '#062b1e', border: 'none', cursor: 'pointer' }}>
                {saving ? 'Saving…' : 'Save Material'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
