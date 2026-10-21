'use client';

/**
 * The PO page's "needs attention" flag (migration 423, src/lib/po-attention.ts).
 * Unflagged: a "⚑ Flag: needs attention" button (or the form straight away
 * when the page was opened from the list's ⚑ with ?flag=1). Flagged: an
 * orange banner with the note, who flagged it and when, Edit note and Done.
 * Done clears the flag and copies the note into po_notes so the history stays.
 */

import { useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import {
  type PoAttention, needsAttention, flagUpdate, CLEAR_ATTENTION, clearedNoteBody, flaggedByLine,
  ATTENTION_QUICK_NOTES, ATTENTION_NOTE_MAX,
} from '@/lib/po-attention';

const ORANGE = '#fb923c';

export default function PoAttentionFlag({ po, user, initialOpen, onSaved, onNoteAdded }: {
  po: PoAttention & { id: string };
  user: { id: string | null; name: string | null };
  initialOpen?: boolean;
  onSaved: (fields: Required<PoAttention>) => void;
  onNoteAdded?: (note: any) => void;
}) {
  const supabase = createClient();
  const flagged = needsAttention(po);
  const [editing, setEditing] = useState(!!initialOpen && !flagged);
  const [note, setNote] = useState(po.attention_note || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const fields = flagUpdate(note, user, po);
    const { error: err } = await supabase.from('purchase_orders').update(fields).eq('id', po.id);
    setSaving(false);
    if (err) { setError(`Couldn’t flag this PO: ${err.message}`); return; }
    onSaved(fields);
    setEditing(false);
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.from('purchase_orders').update(CLEAR_ATTENTION).eq('id', po.id);
    if (err) { setSaving(false); setError(`Couldn’t clear the flag: ${err.message}`); return; }
    // Best-effort history line; the flag is already cleared either way.
    const { data } = await supabase.from('po_notes')
      .insert({ po_id: po.id, author_id: user.id, body: clearedNoteBody(po), mentions: [] })
      .select().single();
    setSaving(false);
    if (data) onNoteAdded?.(data);
    onSaved(CLEAR_ATTENTION);
    setNote('');
  };

  const box: React.CSSProperties = {
    padding: '12px 14px', borderRadius: '12px', background: 'rgba(251,146,60,0.09)', border: '1px solid rgba(251,146,60,0.45)',
  };
  const btn: React.CSSProperties = {
    padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: saving ? 'wait' : 'pointer',
    background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
  };
  const errorLine = error && <div style={{ fontSize: '12px', color: '#f87171', fontWeight: 700 }}>{error}</div>;

  if (editing) {
    return (
      <form style={{ ...box, display: 'flex', flexDirection: 'column', gap: '8px' }} onSubmit={e => { e.preventDefault(); save(); }}>
        <label htmlFor="po-attention-note" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
          What still needs to be done? (optional)
        </label>
        <input id="po-attention-note" autoFocus value={note} maxLength={ATTENTION_NOTE_MAX} onChange={e => setNote(e.target.value)}
          placeholder="e.g. Waiting on revised drawing"
          style={{ padding: '9px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }} />
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {ATTENTION_QUICK_NOTES.map(q => (
            <button key={q} type="button" onClick={() => setNote(q)}
              style={{ padding: '3px 9px', borderRadius: '999px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer' }}>
              {q}
            </button>
          ))}
        </div>
        {errorLine}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button type="submit" disabled={saving} style={{ ...btn, background: ORANGE, border: `1px solid ${ORANGE}`, color: '#1a1206' }}>
            {saving ? 'Saving…' : flagged ? 'Save note' : '⚑ Flag this PO'}
          </button>
          <button type="button" onClick={() => { setEditing(false); setNote(po.attention_note || ''); setError(null); }} style={btn}>Cancel</button>
        </div>
      </form>
    );
  }

  if (!flagged) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <button type="button" onClick={() => setEditing(true)}
          title="Mark this PO so the team sees something still needs to be done"
          style={{ ...btn, alignSelf: 'flex-start', color: ORANGE, border: '1px solid rgba(251,146,60,0.45)' }}>
          ⚑ Flag: needs attention
        </button>
        {errorLine}
      </div>
    );
  }

  return (
    <div style={{ ...box, display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ fontSize: '11px', fontWeight: 800, color: ORANGE, textTransform: 'uppercase', letterSpacing: '0.5px' }}>⚑ Needs attention</div>
        {po.attention_note && <div style={{ fontSize: '14px', color: 'var(--text-primary)', marginTop: '3px', overflowWrap: 'anywhere' }}>{po.attention_note}</div>}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>{flaggedByLine(po)}</div>
        {errorLine}
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => { setNote(po.attention_note || ''); setEditing(true); }} disabled={saving} style={btn}>Edit note</button>
        <button type="button" onClick={clear} disabled={saving}
          title="Clear the flag. The note is kept in this PO's notes."
          style={{ ...btn, color: '#4ade80', border: '1px solid rgba(74,222,128,0.45)' }}>
          {saving ? 'Clearing…' : '✓ Done'}
        </button>
      </div>
    </div>
  );
}
