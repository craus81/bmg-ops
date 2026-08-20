'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import NumberInput from '@/components/NumberInput';
import { MATCH_FIELDS, type MatchField, type MatchType } from '@/lib/part-category-rules';

// Tagging rules for the catalog browser's product categories (migration
// 209). Craig's ask: "all parts from Legend Fleet that have 'liner' in the
// name should be categorized as Wall Liners" — before this, the only way to
// set a category was the per-card dropdown in the browser, one click per
// part, redone every time the NetSuite sync brought new parts in.
//
// Rules run in priority order and the first match wins, so a narrow rule
// needs a LOWER number than the broad one it refines. Nothing here can
// clobber a category a human set by hand — the sweep skips those.

interface Rule {
  id: string;
  name: string | null;
  vendor: string | null;
  match_type: MatchType;
  pattern: string;
  match_fields: string[];
  category_id: string;
  priority: number;
  active: boolean;
  last_run_at: string | null;
  last_matched_count: number | null;
}
interface Category { id: string; name: string }
interface SweepResult {
  scanned: number;
  wouldChange: number;
  applied: number;
  dryRun: boolean;
  cleared: number;
  protectedManual: number;
  matchedByRule: Record<string, number>;
  samplesByRule: Record<string, string[]>;
  candidateRuleId?: string;
}

const FIELD_LABELS: Record<MatchField, string> = {
  item_number: 'Part number',
  display_name: 'Name',
  description: 'Description',
  marketing_description: 'Marketing copy',
};
const MATCH_LABELS: Record<MatchType, string> = {
  contains: 'contains',
  word: 'contains the whole word',
  regex: 'matches the regex',
};

const card: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--border)',
  borderRadius: '12px', padding: '14px',
};
const label: React.CSSProperties = {
  fontSize: '10px', fontWeight: 800, textTransform: 'uppercase',
  letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px',
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 8px', borderRadius: '8px',
  border: '1px solid var(--border)', background: 'var(--input-bg)',
  color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'inherit',
};
function btn(kind: 'primary' | 'ghost' | 'danger', disabled = false): React.CSSProperties {
  return {
    padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
    cursor: disabled ? 'default' : 'pointer',
    background: disabled ? 'var(--subtle-bg)' : kind === 'primary' ? '#3b82f6' : 'transparent',
    color: disabled ? 'var(--text-muted)' : kind === 'primary' ? '#fff' : kind === 'danger' ? '#ef4444' : 'var(--text-primary)',
    border: kind === 'primary' ? 'none' : `1px solid ${kind === 'danger' ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
  };
}

const BLANK = {
  id: null as string | null,
  name: '',
  vendor: '',
  matchType: 'contains' as MatchType,
  pattern: '',
  matchFields: ['item_number', 'display_name'] as MatchField[],
  categoryId: '',
  priority: 100,
};

export default function PartCategoryRulesPage() {
  const router = useRouter();
  const { isAdmin, user, loading: authLoading } = useAuth();
  const dialog = useDialog();

  const [rules, setRules] = useState<Rule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({ ...BLANK });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<SweepResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [sweeping, setSweeping] = useState(false);

  useEffect(() => {
    if (authLoading || !user) return; // role flags resolve after auth loads
    if (!isAdmin) router.push('/home');
  }, [authLoading, user, isAdmin, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/parts/category-rules');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setRules(d.rules || []);
      setCategories(d.categories || []);
      setVendors(d.vendors || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load rules');
    }
    setLoading(false);
  }, []);
  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const categoryName = (id: string) => categories.find(c => c.id === id)?.name || 'Unknown category';
  const fieldList = (fields: string[]) =>
    fields.map(f => (FIELD_LABELS[f as MatchField] || f).toLowerCase()).join(' or ');

  const editRule = (r: Rule) => {
    setForm({
      id: r.id, name: r.name || '', vendor: r.vendor || '', matchType: r.match_type,
      pattern: r.pattern, matchFields: r.match_fields as MatchField[],
      categoryId: r.category_id, priority: r.priority,
    });
    setPreview(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const candidateBody = () => ({
    id: form.id || undefined,
    vendor: form.vendor || null,
    matchType: form.matchType,
    pattern: form.pattern.trim(),
    matchFields: form.matchFields,
    categoryId: form.categoryId,
    priority: form.priority,
  });
  const formReady = !!form.pattern.trim() && !!form.categoryId && form.matchFields.length > 0;

  /** Dry-run the rule being edited, folded into the saved set so the count
   *  reflects the priority order it will really run in. */
  const previewCandidate = async () => {
    if (!formReady) return;
    setPreviewing(true);
    setPreview(null);
    try {
      const res = await fetch('/api/parts/category-rules/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, candidate: candidateBody() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setPreview(d);
    } catch (err: any) {
      await dialog.alert(`Preview failed: ${err.message}`);
    }
    setPreviewing(false);
  };

  const saveRule = async () => {
    if (!formReady) return;
    setSaving(true);
    try {
      const res = await fetch('/api/parts/category-rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...candidateBody(), name: form.name || null }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setForm({ ...BLANK });
      setPreview(null);
      await load();
    } catch (err: any) {
      await dialog.alert(`Save failed: ${err.message}`);
    }
    setSaving(false);
  };

  const toggleRule = async (r: Rule) => {
    const res = await fetch('/api/parts/category-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: r.id, name: r.name, vendor: r.vendor, matchType: r.match_type,
        pattern: r.pattern, matchFields: r.match_fields, categoryId: r.category_id,
        priority: r.priority, active: !r.active,
      }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      await dialog.alert(`Failed to update: ${d.error || res.status}`);
      return;
    }
    load();
  };

  const removeRule = async (r: Rule) => {
    const owned = r.last_matched_count || 0;
    const ok = await dialog.confirm(
      `Delete this rule?${owned ? ` The ${owned} part${owned === 1 ? '' : 's'} it categorized will go back to uncategorized.` : ''} Categories set by hand are not affected.`,
      { destructive: true, confirmLabel: 'Delete' },
    );
    if (!ok) return;
    const res = await fetch('/api/parts/category-rules', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: r.id }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      await dialog.alert(`Delete failed: ${d.error || res.status}`);
      return;
    }
    if (form.id === r.id) setForm({ ...BLANK });
    load();
  };

  /** Run every active rule over the catalog — preview first, then apply. */
  const runSweep = async (dryRun: boolean) => {
    if (!dryRun) {
      const pending = sweep && sweep.dryRun ? sweep.wouldChange : null;
      const ok = await dialog.confirm(
        pending === null
          ? 'Apply all active rules to the catalog?'
          : `Apply all active rules? ${pending} part${pending === 1 ? '' : 's'} will change category.`,
        { confirmLabel: 'Apply rules' },
      );
      if (!ok) return;
    }
    setSweeping(true);
    try {
      const res = await fetch('/api/parts/category-rules/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setSweep(d);
      if (!dryRun) await load();
    } catch (err: any) {
      await dialog.alert(`${dryRun ? 'Preview' : 'Apply'} failed: ${err.message}`);
    }
    setSweeping(false);
  };

  if (!user || !isAdmin) return null;

  const previewCount = preview
    ? preview.matchedByRule[preview.candidateRuleId || ''] ?? 0
    : 0;
  const previewSamples = preview
    ? preview.samplesByRule[preview.candidateRuleId || ''] || []
    : [];

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Part Tagging Rules</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', maxWidth: '760px' }}>
          Categorize parts automatically instead of one dropdown at a time — e.g. <em>Legend Fleet
          parts with &ldquo;liner&rdquo; in the name → Wall Liners</em>. Rules run in priority order and the
          first match wins, so put a narrow rule <strong>above</strong> the broad one it refines. They
          re-run after every NetSuite parts sync, so new parts land in the right category on their own.
          A category you set by hand in the catalog browser always wins and is never overwritten.
        </div>
      </div>

      {/* ── Rule editor ── */}
      <div style={{ ...card, marginBottom: '16px' }}>
        <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '10px' }}>
          {form.id ? 'Edit rule' : 'New rule'}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
          <div>
            <div style={label}>Vendor</div>
            <select value={form.vendor} onChange={e => { setForm(f => ({ ...f, vendor: e.target.value })); setPreview(null); }} style={input}>
              <option value="">Any vendor</option>
              {vendors.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <div style={label}>Match</div>
            <select value={form.matchType} onChange={e => { setForm(f => ({ ...f, matchType: e.target.value as MatchType })); setPreview(null); }} style={input}>
              <option value="contains">Contains</option>
              <option value="word">Whole word</option>
              <option value="regex">Regex</option>
            </select>
          </div>
          <div>
            <div style={label}>Text</div>
            <input
              value={form.pattern}
              onChange={e => { setForm(f => ({ ...f, pattern: e.target.value })); setPreview(null); }}
              placeholder="liner"
              style={input}
            />
          </div>
          <div>
            <div style={label}>Category</div>
            <select value={form.categoryId} onChange={e => { setForm(f => ({ ...f, categoryId: e.target.value })); setPreview(null); }} style={input}>
              <option value="">Choose a category…</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <div style={label}>Priority</div>
            <NumberInput
              min={0} max={10000} value={form.priority}
              onChange={e => { setForm(f => ({ ...f, priority: Number(e.target.value) })); setPreview(null); }}
              style={input}
            />
          </div>
          <div>
            <div style={label}>Label (optional)</div>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Legend wall liners" style={input} />
          </div>
        </div>

        <div style={{ marginTop: '10px' }}>
          <div style={label}>Search these fields</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            {MATCH_FIELDS.map(f => (
              <label key={f} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.matchFields.includes(f)}
                  onChange={e => {
                    setPreview(null);
                    setForm(prev => ({
                      ...prev,
                      matchFields: e.target.checked
                        ? [...prev.matchFields, f]
                        : prev.matchFields.filter(x => x !== f),
                    }));
                  }}
                />
                {FIELD_LABELS[f]}
              </label>
            ))}
          </div>
        </div>

        {form.matchType === 'contains' && form.pattern.trim() && (
          <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
            Heads up: <strong>contains</strong> also matches inside longer words — &ldquo;{form.pattern.trim()}&rdquo;
            would hit &ldquo;head{form.pattern.trim()}&rdquo;. Use <strong>whole word</strong> if that&apos;s not what you want.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
          <button onClick={previewCandidate} disabled={!formReady || previewing} style={btn('ghost', !formReady || previewing)}>
            {previewing ? 'Checking…' : 'Preview matches'}
          </button>
          <button onClick={saveRule} disabled={!formReady || saving} style={btn('primary', !formReady || saving)}>
            {saving ? 'Saving…' : form.id ? 'Save changes' : 'Add rule'}
          </button>
          {form.id && (
            <button onClick={() => { setForm({ ...BLANK }); setPreview(null); }} style={btn('ghost')}>Cancel</button>
          )}
          {preview && (
            <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
              Claims <strong>{previewCount}</strong> part{previewCount === 1 ? '' : 's'}
              {previewSamples.length > 0 && (
                <span style={{ color: 'var(--text-muted)' }}> — e.g. {previewSamples.join(', ')}</span>
              )}
              {previewCount === 0 && (
                <span style={{ color: 'var(--text-muted)' }}> — nothing matches, or a higher-priority rule claims them first</span>
              )}
            </div>
          )}
        </div>
        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
          Saving a rule doesn&apos;t move any parts on its own — press <strong>Apply rules</strong> below (or wait for the next parts sync).
        </div>
      </div>

      {/* ── Sweep ── */}
      <div style={{ ...card, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button onClick={() => runSweep(true)} disabled={sweeping} style={btn('ghost', sweeping)}>
          {sweeping ? 'Working…' : 'Preview all rules'}
        </button>
        <button onClick={() => runSweep(false)} disabled={sweeping} style={btn('primary', sweeping)}>Apply rules</button>
        {sweep && (
          <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
            {sweep.dryRun
              ? <><strong>{sweep.wouldChange}</strong> part{sweep.wouldChange === 1 ? '' : 's'} would change</>
              : <><strong>{sweep.applied}</strong> part{sweep.applied === 1 ? '' : 's'} updated</>}
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}· {sweep.scanned.toLocaleString()} scanned · {sweep.cleared} cleared · {sweep.protectedManual} left alone (set by hand)
            </span>
          </div>
        )}
      </div>

      {/* ── Rules ── */}
      <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '8px' }}>
        Rules ({rules.filter(r => r.active).length} of {rules.length} active) · first match wins
      </div>
      {error && <div style={{ ...card, color: '#ef4444', fontSize: '12px', marginBottom: '8px' }}>{error}</div>}
      {loading ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      ) : rules.length === 0 ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: '12px' }}>
          No rules yet. Add one above — parts stay exactly as they are until you do.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {rules.map(r => (
            <div key={r.id} style={{ ...card, padding: '12px', opacity: r.active ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', minWidth: '34px', textAlign: 'right', paddingTop: '2px' }}>{r.priority}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                    <strong>{r.vendor || 'Any vendor'}</strong>
                    {' · '}{fieldList(r.match_fields)} {MATCH_LABELS[r.match_type]}{' '}
                    <code style={{ background: 'var(--subtle-bg)', padding: '1px 5px', borderRadius: '4px' }}>{r.pattern}</code>
                    {' → '}<strong>{categoryName(r.category_id)}</strong>
                  </div>
                  <div style={{ marginTop: '5px', fontSize: '10px', color: 'var(--text-muted)' }}>
                    {r.name ? `${r.name} · ` : ''}
                    {r.last_run_at
                      ? `${r.last_matched_count ?? 0} part${r.last_matched_count === 1 ? '' : 's'} as of ${new Date(r.last_run_at).toLocaleString()}`
                      : 'Never applied'}
                    {!r.active && ' · disabled'}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flexShrink: 0 }}>
                  <button onClick={() => toggleRule(r)} style={{ ...btn('ghost'), padding: '4px 10px', fontSize: '10px', color: r.active ? '#f59e0b' : '#22c55e' }}>
                    {r.active ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => editRule(r)} style={{ ...btn('ghost'), padding: '4px 10px', fontSize: '10px', color: '#60a5fa' }}>Edit</button>
                  <button onClick={() => removeRule(r)} style={{ ...btn('danger'), padding: '4px 10px', fontSize: '10px' }}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
