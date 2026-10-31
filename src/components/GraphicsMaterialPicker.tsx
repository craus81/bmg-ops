'use client';

/**
 * Vinyl Type / Laminate / Premask drop-downs on graphics jobs (Craig
 * 2026-10-30). Each list ends with "Other…", which opens a text box under
 * it; what's typed is what the job saves. Admins can tick "Add to the list"
 * to put it on the drop-down for everyone. Lists come from
 * /api/graphics/material-options (migration 459).
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  MATERIAL_KINDS, MATERIAL_KIND_LABEL, emptyMaterialLists, matchOption,
  type MaterialKind, type MaterialOptionLists,
} from '@/lib/graphics-material-options';

const OTHER = '__other';

// One fetch per page load, shared by every picker on the screen.
let cached: MaterialOptionLists | null = null;
let inflight: Promise<MaterialOptionLists | null> | null = null;
const listeners = new Set<(l: MaterialOptionLists) => void>();

function publish(lists: MaterialOptionLists) {
  cached = lists;
  listeners.forEach(fn => fn(lists));
}

async function fetchLists(): Promise<MaterialOptionLists | null> {
  try {
    const res = await apiFetch('/api/graphics/material-options');
    const data = await res.json();
    if (!res.ok || !data?.lists) return null;
    publish(data.lists);
    return data.lists;
  } catch {
    return null;
  } finally {
    inflight = null;
  }
}

export function useGraphicsMaterialOptions(): MaterialOptionLists {
  const [lists, setLists] = useState<MaterialOptionLists>(cached || emptyMaterialLists());
  useEffect(() => {
    listeners.add(setLists);
    if (cached) setLists(cached);
    else if (!inflight) inflight = fetchLists();
    return () => { listeners.delete(setLists); };
  }, []);
  return lists;
}

/** POST/DELETE the list and share the result with every picker. Returns an error message or null. */
async function changeList(method: 'POST' | 'DELETE', body: Record<string, string>): Promise<string | null> {
  try {
    const res = await apiFetch('/api/graphics/material-options', { method, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.lists) return data?.error || 'Could not update the list.';
    publish(data.lists);
    return null;
  } catch (e: any) {
    return e?.message || 'Could not update the list.';
  }
}

export function GraphicsMaterialPicker({ kind, value, onChange, canAddToList, labelStyle, inputStyle }: {
  kind: MaterialKind;
  value: string | null | undefined;
  onChange: (v: string) => void;
  canAddToList: boolean;
  labelStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
}) {
  const lists = useGraphicsMaterialOptions();
  const options = lists[kind];
  const match = matchOption(value, options);
  const [otherMode, setOtherMode] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const text = value || '';
  // Until the lists arrive, show the saved value as-is rather than flashing
  // the Other… box for something that's really on the list.
  const loaded = MATERIAL_KINDS.some(k => lists[k].length > 0);
  const pending = !loaded && !match && text.trim() !== '' && !otherMode;
  const showOther = !pending && (otherMode || (!match && text.trim() !== ''));

  const pick = (v: string) => {
    setError('');
    if (v === OTHER) {
      setOtherMode(true);
      if (match) onChange('');
      return;
    }
    setOtherMode(false);
    onChange(v);
  };

  const addToList = async () => {
    if (!text.trim()) return;
    setAdding(true);
    setError('');
    const err = await changeList('POST', { kind, name: text });
    setAdding(false);
    if (err) { setError(err); return; }
    setOtherMode(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <div style={{ ...labelStyle, fontSize: '8px', marginBottom: 0 }}>{MATERIAL_KIND_LABEL[kind]}</div>
      <select style={inputStyle} value={match ? match.name : pending ? text : showOther ? OTHER : ''} onChange={e => pick(e.target.value)}>
        <option value="">Select...</option>
        {pending && <option value={text}>{text}</option>}
        {options.map(o => <option key={o.id} value={o.name}>{o.name}</option>)}
        <option value={OTHER}>Other…</option>
      </select>
      {showOther && (
        <>
          <input
            style={inputStyle}
            value={text}
            onChange={e => { setError(''); onChange(e.target.value); }}
            placeholder={`Type ${MATERIAL_KIND_LABEL[kind].toLowerCase()}`}
            autoFocus={otherMode && !text}
          />
          {canAddToList && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: 'var(--text-label)', cursor: text.trim() ? 'pointer' : 'default', opacity: text.trim() ? 1 : 0.5 }}>
              <input type="checkbox" checked={adding} disabled={!text.trim() || adding} onChange={addToList} style={{ width: 'auto', margin: 0 }} />
              {adding ? 'Adding…' : 'Add to the list'}
            </label>
          )}
        </>
      )}
      {error && <div style={{ fontSize: '10px', color: '#ef4444' }}>{error}</div>}
    </div>
  );
}

/** Settings card: see each list, add an item, remove one. Admins only. */
export function GraphicsMaterialListsCard({ sectionStyle, inputStyle }: {
  sectionStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
}) {
  const lists = useGraphicsMaterialOptions();
  const [drafts, setDrafts] = useState<Record<MaterialKind, string>>({ vinyl: '', laminate: '', premask: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const add = async (kind: MaterialKind) => {
    if (!drafts[kind].trim()) return;
    setBusy(`add-${kind}`);
    setError('');
    const err = await changeList('POST', { kind, name: drafts[kind] });
    setBusy(null);
    if (err) { setError(err); return; }
    setDrafts(d => ({ ...d, [kind]: '' }));
  };

  const remove = async (id: string) => {
    setBusy(id);
    setError('');
    const err = await changeList('DELETE', { id });
    setBusy(null);
    if (err) setError(err);
  };

  return (
    <div style={sectionStyle}>
      <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Graphics Job Material Lists</div>
      <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
        The Vinyl Type, Laminate and Premask drop-downs on graphics jobs. Removing an item doesn&apos;t change jobs that already use it.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        {MATERIAL_KINDS.map(kind => (
          <div key={kind} style={{ minWidth: 0 }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>
              {MATERIAL_KIND_LABEL[kind]}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '6px' }}>
              {lists[kind].map(o => (
                <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', padding: '4px 8px', borderRadius: '6px', background: 'var(--bg)', fontSize: '12px', color: 'var(--text-body)' }}>
                  <span style={{ overflowWrap: 'anywhere' }}>{o.name}</span>
                  <button
                    onClick={() => remove(o.id)}
                    disabled={busy === o.id}
                    aria-label={`Remove ${o.name}`}
                    style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '13px', fontWeight: 800, cursor: 'pointer', padding: '0 2px' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {lists[kind].length === 0 && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Nothing on this list yet.</div>}
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              <input
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                value={drafts[kind]}
                onChange={e => setDrafts(d => ({ ...d, [kind]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') add(kind); }}
                placeholder="Add an item"
              />
              <button
                onClick={() => add(kind)}
                disabled={!drafts[kind].trim() || busy === `add-${kind}`}
                style={{ padding: '6px 10px', borderRadius: '8px', border: 'none', background: '#22c55e', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: 'pointer', opacity: drafts[kind].trim() ? 1 : 0.5 }}
              >
                Add
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{error}</div>}
    </div>
  );
}
