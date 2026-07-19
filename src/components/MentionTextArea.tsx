'use client';

/**
 * Note input with @mention autocomplete: type "@" and pick a teammate.
 * Drop-in for the plain inputs on every notes surface — the host page
 * still owns value/onChange and saving; after a successful save it calls
 * reportMentions() (below) so the tagged people get their inbox entry +
 * push. Parsing/authorization happen server-side in /api/mentions.
 */

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase-browser';

interface StaffOption { id: string; name: string }

// Module-level cache — every notes surface shares one staff list per page.
let staffCache: StaffOption[] | null = null;

export async function reportMentions(input: {
  text: string;
  sourceType: string;
  sourceId?: string | null;
  contextLabel: string;
  contextUrl: string;
  /** Explicit tag-picker IDs (e.g. PO note chips) — skips @text parsing. */
  userIds?: string[];
}): Promise<void> {
  if (!input.text.includes('@') && !input.userIds?.length) return;
  try {
    await fetch('/api/mentions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch { /* mentions are best-effort — the note itself already saved */ }
}

export default function MentionTextArea({
  value, onChange, placeholder, rows = 1, style, onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  style?: React.CSSProperties;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const supabase = createClient();
  const [staff, setStaff] = useState<StaffOption[]>(staffCache || []);
  const [dropdown, setDropdown] = useState<StaffOption[]>([]);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (staffCache) return;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, role, roles')
        .eq('status', 'approved')
        .order('full_name');
      const options = (data || [])
        .filter((p: any) => {
          const roles: string[] = p.roles?.length ? p.roles : [p.role];
          return !roles.includes('customer') && p.full_name;
        })
        .map((p: any) => ({ id: p.id, name: p.full_name }));
      staffCache = options;
      setStaff(options);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per app session
  }, []);

  // The "@query" fragment under the caret, if any.
  const activeMention = (): { start: number; query: string } | null => {
    const el = areaRef.current;
    if (!el) return null;
    const caret = el.selectionStart ?? value.length;
    const upToCaret = value.slice(0, caret);
    const at = upToCaret.lastIndexOf('@');
    if (at === -1) return null;
    const query = upToCaret.slice(at + 1);
    if (query.includes('\n') || query.length > 30) return null;
    // Only trigger at a word boundary ("email@..." shouldn't).
    if (at > 0 && /[A-Za-z0-9]/.test(upToCaret[at - 1])) return null;
    return { start: at, query };
  };

  const refreshDropdown = (nextValue: string) => {
    onChange(nextValue);
    // Defer until caret position settles.
    requestAnimationFrame(() => {
      const m = activeMention();
      if (!m) { setDropdown([]); return; }
      const q = m.query.toLowerCase();
      setDropdown(staff.filter(s => s.name.toLowerCase().includes(q)).slice(0, 6));
    });
  };

  const pick = (s: StaffOption) => {
    const m = activeMention();
    const el = areaRef.current;
    if (!m || !el) return;
    const caret = el.selectionStart ?? value.length;
    const next = `${value.slice(0, m.start)}@${s.name} ${value.slice(caret)}`;
    onChange(next);
    setDropdown([]);
    requestAnimationFrame(() => el.focus());
  };

  return (
    <div style={{ position: 'relative', flex: (style as any)?.flex }}>
      <textarea
        ref={areaRef}
        value={value}
        onChange={e => refreshDropdown(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setDropdown([]), 200)}
        placeholder={placeholder}
        rows={rows}
        style={{ resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box', ...style, flex: undefined }}
      />
      {dropdown.length > 0 && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 60, marginBottom: '2px',
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.25)', overflow: 'hidden',
        }}>
          {dropdown.map(s => (
            <button
              key={s.id}
              onMouseDown={e => { e.preventDefault(); pick(s); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              @{s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
