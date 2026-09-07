'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { RollNesting, type RollFilmInfo } from '@/components/RollNesting';
import {
  DEFAULT_ROLL,
  type NestPiece,
  type PlacementMap,
  type RollConfig,
  computeUsage,
  packPieces,
  pieceKey,
  reconcilePlacements,
  splitForRoll,
} from '@/lib/roll-nesting';

/**
 * The production Roll Plan (§7.4 floor build): the wrap-quote nesting
 * engine, pointed at a graphics job. Production lists the pieces to print
 * (or pulls them straight from the linked wrap quote's measurements), lays
 * them on the roll with the same MaxRects packer + drag canvas, saves the
 * plan on the job (graphics_jobs.nesting, migration 266), and logs the
 * computed roll usage into graphics_job_materials in one click — ending
 * the manual, inventory-blind material typing the audit called out.
 */

interface PieceDef { name: string; w: number; h: number; qty: number }

interface PlanSnapshot {
  v: 1;
  config: RollConfig;
  sets: number;
  pieceDefs: PieceDef[];
  placements: PlacementMap;
  savedAt: string;
}

interface Props {
  jobId: string;
  jobQuantity: number | null;
  vinylType: string | null;
  vinylColor: string | null;
  wrapQuoteId: string | null;
  nesting: unknown;
}

const PIECE_CAP = 400;
const num1 = (n: number) => Math.round(n * 10) / 10;

function parseSnapshot(raw: unknown): PlanSnapshot | null {
  const s = raw as PlanSnapshot | null;
  if (!s || s.v !== 1 || !Array.isArray(s.pieceDefs) || !s.config) return null;
  return s;
}

export default function GraphicsRollPlan({ jobId, jobQuantity, vinylType, vinylColor, wrapQuoteId, nesting }: Props) {
  const supabase = createClient();
  const { user } = useAuth();
  const saved = useMemo(() => parseSnapshot(nesting), [nesting]);

  const [open, setOpen] = useState(!!saved);
  const [pieceDefs, setPieceDefs] = useState<PieceDef[]>(saved?.pieceDefs || []);
  const [sets, setSets] = useState<number>(saved?.sets || Math.max(1, jobQuantity || 1));
  const [config, setConfig] = useState<RollConfig>(saved?.config || DEFAULT_ROLL);
  const [placements, setPlacements] = useState<PlacementMap>(saved?.placements || {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const filmKey = vinylType || 'vinyl';
  const filmLabel = [vinylType || 'Vinyl', vinylColor].filter(Boolean).join(' — ');
  const films: RollFilmInfo[] = useMemo(
    () => [{ key: filmKey, label: filmLabel, color: '#3b82f6', ratePerSqft: 0 }],
    [filmKey, filmLabel],
  );

  // Piece defs → physical NestPieces: each def × qty × sets, split for the
  // roll width the same way the quote enumeration does. Capped, with the
  // overflow disclosed rather than silently dropped.
  const { nestPieces, capped } = useMemo(() => {
    const out: NestPiece[] = [];
    let cut = false;
    outer: for (let di = 0; di < pieceDefs.length; di++) {
      const def = pieceDefs[di];
      if (!(def.w > 0) || !(def.h > 0)) continue;
      const qty = Math.max(1, Math.floor(def.qty) || 1);
      for (let s = 0; s < sets; s++) {
        for (let c = 0; c < qty; c++) {
          const parts = splitForRoll(def.w, def.h, config);
          for (const part of parts) {
            if (out.length >= PIECE_CAP) { cut = true; break outer; }
            out.push({
              key: pieceKey(`d${di}`, c, s, Math.max(0, part.partIndex), filmKey),
              filmKey,
              name: def.name || `Piece ${di + 1}`,
              w: part.w,
              h: part.h,
              set: s,
              copy: c,
              part: part.partIndex >= 0 ? String.fromCharCode(65 + part.partIndex) : '',
            });
          }
        }
      }
    }
    return { nestPieces: out, capped: cut };
  }, [pieceDefs, sets, config, filmKey]);

  // New pieces flow into open gaps; a manual arrangement survives edits.
  useEffect(() => {
    setPlacements(prev => reconcilePlacements(nestPieces, prev, config));
  }, [nestPieces, config]);

  const usage = useMemo(() => computeUsage(nestPieces, placements, config), [nestPieces, placements, config]);
  const film = usage.films[0];

  const loadFromQuote = async () => {
    if (!wrapQuoteId || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const { data, error } = await supabase
        .from('wrap_quotes').select('measurements').eq('id', wrapQuoteId).maybeSingle();
      if (error || !data) { setMsg({ kind: 'err', text: error?.message || 'Could not read the wrap quote.' }); return; }
      const ms: any[] = Array.isArray(data.measurements) ? data.measurements : [];
      const defs = ms
        .filter(m => Number(m.dim1_in) > 0 && Number(m.dim2_in) > 0)
        .map((m, i) => ({
          name: m.name || `Area ${i + 1}`,
          w: num1(Number(m.dim1_in)),
          h: num1(Number(m.dim2_in)),
          qty: Math.max(1, Number(m.qty) || 1),
        }));
      if (defs.length === 0) { setMsg({ kind: 'err', text: 'The linked wrap quote has no measured areas.' }); return; }
      setPieceDefs(defs);
      setPlacements({});
    } finally {
      setBusy(false);
    }
  };

  const savePlan = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const snapshot: PlanSnapshot = { v: 1, config, sets, pieceDefs, placements, savedAt: new Date().toISOString() };
      const { error } = await supabase.from('graphics_jobs').update({ nesting: snapshot }).eq('id', jobId);
      setMsg(error ? { kind: 'err', text: `Save failed: ${error.message}` } : { kind: 'ok', text: 'Roll plan saved on the job.' });
    } finally {
      setBusy(false);
    }
  };

  const logMaterial = async () => {
    if (busy || !film || film.rollSqft <= 0) return;
    setBusy(true);
    setMsg(null);
    try {
      // Rate hint: the shop's own last logged $/ft² for this material —
      // the same price book the materials card shows.
      let cost: number | null = null;
      const { data: last } = await supabase
        .from('graphics_job_materials')
        .select('cost, quantity_sqft')
        .eq('material_name', filmLabel)
        .gt('cost', 0)
        .gt('quantity_sqft', 0)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (last?.cost && last?.quantity_sqft) {
        cost = Math.round((Number(last.cost) / Number(last.quantity_sqft)) * film.rollSqft * 100) / 100;
      }
      const usedLenIn = film.rolls.reduce((s, r) => s + r.usedLengthIn, 0);
      const { error } = await supabase.from('graphics_job_materials').insert({
        graphics_job_id: jobId,
        material_name: filmLabel,
        category: 'vinyl',
        quantity_sqft: num1(film.rollSqft),
        linear_feet: num1(usedLenIn / 12),
        cost,
        notes: `Roll plan: ${film.placedCount} piece${film.placedCount !== 1 ? 's' : ''} on ${film.rolls.length} roll${film.rolls.length !== 1 ? 's' : ''} × ${config.widthIn}"${usage.unplaced.length > 0 ? ` (${usage.unplaced.length} unplaced — not counted)` : ''}`,
        logged_by: user?.id || null,
      });
      setMsg(error
        ? { kind: 'err', text: `Material log failed: ${error.message}` }
        : { kind: 'ok', text: `Logged ${num1(film.rollSqft)} ft² of ${filmLabel}${cost != null ? ` at ~$${cost.toFixed(2)}` : ' (no rate on file — set the cost on the material log)'}. Refresh the materials card to see it.` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Roll Plan
        </div>
        {film && film.rollSqft > 0 && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {num1(film.rollSqft)} ft² of roll · {film.placedCount}/{nestPieces.length} pieces placed
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={() => setOpen(o => !o)}
          style={{ padding: '5px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {open ? 'Hide' : pieceDefs.length > 0 ? 'Open plan' : 'Plan this job on the roll'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
            {wrapQuoteId && (
              <button onClick={loadFromQuote} disabled={busy}
                style={{ padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.35)', color: '#3b82f6' }}>
                Load pieces from the wrap quote
              </button>
            )}
            <button onClick={() => setPieceDefs(prev => [...prev, { name: '', w: 0, h: 0, qty: 1 }])} disabled={busy}
              style={{ padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
              + Piece
            </button>
            <button onClick={() => { const { placements: packed } = packPieces(nestPieces, config); setPlacements(packed); }} disabled={busy || nestPieces.length === 0}
              style={{ padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
              Auto-nest
            </button>
            <button onClick={savePlan} disabled={busy || pieceDefs.length === 0}
              style={{ padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', color: '#22c55e' }}>
              Save plan
            </button>
            <button onClick={logMaterial} disabled={busy || !film || film.rollSqft <= 0}
              title="Write the computed roll usage into this job's material log (sqft, linear ft, cost from the last logged rate)"
              style={{ padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.35)', color: '#f97316' }}>
              Log material from plan
            </button>
          </div>

          {/* Piece list — the job's printable pieces in inches. */}
          {pieceDefs.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
              {pieceDefs.map((d, i) => (
                <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input value={d.name} placeholder={`Piece ${i + 1}`}
                    onChange={e => setPieceDefs(prev => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    style={{ flex: '1 1 140px', minWidth: '120px', padding: '6px 8px', borderRadius: '7px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
                  <input type="number" value={d.w || ''} placeholder="W in" min={0} step={0.1}
                    onChange={e => setPieceDefs(prev => prev.map((x, j) => (j === i ? { ...x, w: parseFloat(e.target.value) || 0 } : x)))}
                    style={{ width: '76px', padding: '6px 8px', borderRadius: '7px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>×</span>
                  <input type="number" value={d.h || ''} placeholder="H in" min={0} step={0.1}
                    onChange={e => setPieceDefs(prev => prev.map((x, j) => (j === i ? { ...x, h: parseFloat(e.target.value) || 0 } : x)))}
                    style={{ width: '76px', padding: '6px 8px', borderRadius: '7px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
                  <input type="number" value={d.qty} min={1} step={1} title="Copies per set"
                    onChange={e => setPieceDefs(prev => prev.map((x, j) => (j === i ? { ...x, qty: Math.max(1, parseInt(e.target.value, 10) || 1) } : x)))}
                    style={{ width: '60px', padding: '6px 8px', borderRadius: '7px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
                  <button onClick={() => setPieceDefs(prev => prev.filter((_, j) => j !== i))}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px', padding: '0 4px' }}>×</button>
                </div>
              ))}
            </div>
          )}
          {pieceDefs.length === 0 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              List the pieces to print (W × H in inches, copies per set){wrapQuoteId ? ' — or pull them from the linked wrap quote.' : '.'} “Sets” below multiplies the whole list per unit.
            </div>
          )}
          {capped && (
            <div style={{ fontSize: '11.5px', color: '#f59e0b', marginBottom: '8px' }}>
              Layout capped at {PIECE_CAP} pieces — the usage below covers the placed pieces only.
            </div>
          )}

          {nestPieces.length > 0 && (
            <RollNesting
              pieces={nestPieces}
              films={films}
              config={config}
              onConfigChange={setConfig}
              placements={placements}
              onPlacementsChange={setPlacements}
              sets={sets}
              onSetsChange={n => setSets(Math.max(1, Math.floor(n) || 1))}
              useRollPricing={false}
              onUseRollPricingChange={() => { /* pricing lives on quotes; production logs usage instead */ }}
            />
          )}

          {msg && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: msg.kind === 'ok' ? '#22c55e' : 'var(--danger, #ef4444)' }}>{msg.text}</div>
          )}
        </div>
      )}
    </div>
  );
}
