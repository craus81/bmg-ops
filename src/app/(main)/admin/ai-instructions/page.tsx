'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { createClient } from '@/lib/supabase-browser';

// Admin-editable rules that get prepended to FleetSuite AI's system
// prompt on every chat request. Lets admins steer behavior ("when
// quoting wraps, always separate window film panels from body
// panels", "address Craig as one of the owners") without a deploy.
//
// Server pulls rows where enabled = true and merges them into the
// system prompt — see /api/ai-agent/chat. This page only manages the
// global scope; user-scoped preferences live in /settings later.

interface Instruction {
  id: string;
  scope: 'global' | 'user';
  content: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
}

export default function AiInstructionsPage() {
  const router = useRouter();
  const { isAdmin, hasFeature, user, loading: authLoading } = useAuth();
  const supabase = createClient();
  const dialog = useDialog();

  const [rows, setRows] = useState<Instruction[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');

  useEffect(() => {
    if (authLoading || !user) return; // role flags aren't resolved until auth finishes loading
    if (!hasFeature('ai_instructions')) router.push('/home');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasFeature is stable per auth state
  }, [authLoading, user, isAdmin, router]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await supabase
      .from('ai_instructions')
      .select('id, scope, content, enabled, sort_order, created_at')
      .eq('scope', 'global')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (err) {
      console.error('[ai instructions] load failed:', err);
      setError(err.message);
    } else {
      setRows((data || []) as Instruction[]);
      setError(null);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const addInstruction = async () => {
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.from('ai_instructions').insert({
      scope: 'global',
      content: text,
      enabled: true,
      sort_order: (rows[rows.length - 1]?.sort_order ?? 0) + 10,
      created_by: user?.id,
    });
    setSaving(false);
    if (err) {
      console.error('[ai instructions] insert failed:', err);
      setError(err.message);
      return;
    }
    setDraft('');
    load();
  };

  const toggle = async (row: Instruction) => {
    const { error: err } = await supabase
      .from('ai_instructions')
      .update({ enabled: !row.enabled, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (err) {
      await dialog.alert(`Failed to update: ${err.message}`);
      return;
    }
    load();
  };

  const remove = async (row: Instruction) => {
    if (!(await dialog.confirm('Delete this instruction? It will stop influencing the AI immediately.', { destructive: true, confirmLabel: 'Delete' }))) return;
    const { error: err } = await supabase.from('ai_instructions').delete().eq('id', row.id);
    if (err) {
      await dialog.alert(`Failed to delete: ${err.message}`);
      return;
    }
    load();
  };

  const startEdit = (row: Instruction) => {
    setEditingId(row.id);
    setEditingDraft(row.content);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const text = editingDraft.trim();
    if (!text) return;
    const { error: err } = await supabase
      .from('ai_instructions')
      .update({ content: text, updated_at: new Date().toISOString() })
      .eq('id', editingId);
    if (err) {
      await dialog.alert(`Failed to save: ${err.message}`);
      return;
    }
    setEditingId(null);
    setEditingDraft('');
    load();
  };

  if (!user) return null;
  if (!hasFeature('ai_instructions')) return null;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>AI Instructions</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', maxWidth: '720px' }}>
          Free-form rules that get prepended to FleetSuite AI&apos;s system prompt on every chat
          request. Use this to lock in behaviors without redeploying — formatting preferences,
          domain-specific definitions, escalation paths, reminders about who&apos;s who. Disabling
          a rule keeps the wording but stops it from influencing the AI.
        </div>
      </div>

      {/* New instruction */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px',
        padding: '14px', marginBottom: '16px',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
          New instruction
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='e.g. "When breaking down vehicle wrap panels, always separate window film panels (E, G, H, I, J) from body wrap panels and show two subtotals."'
          rows={3}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px',
            borderRadius: '8px', border: '1px solid var(--border)',
            background: 'var(--input-bg)', color: 'var(--text-primary)',
            fontSize: '13px', fontFamily: 'inherit', resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Applies to all users. Takes effect on the next chat message.
          </div>
          <button
            onClick={addInstruction}
            disabled={saving || !draft.trim()}
            style={{
              padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: saving || !draft.trim() ? 'var(--subtle-bg)' : '#3b82f6',
              color: saving || !draft.trim() ? 'var(--text-muted)' : '#fff',
              border: 'none', cursor: saving || !draft.trim() ? 'default' : 'pointer',
            }}
          >{saving ? 'Saving…' : 'Add Instruction'}</button>
        </div>
        {error && (
          <div style={{ marginTop: '8px', fontSize: '11px', color: '#ef4444' }}>{error}</div>
        )}
      </div>

      {/* Existing instructions */}
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
        Active rules ({rows.filter(r => r.enabled).length} of {rows.length} enabled)
      </div>
      {loading ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: '12px' }}>
          No instructions yet. Add one above to start steering the AI.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {rows.map((row, i) => (
            <div key={row.id} style={{
              padding: '12px', borderRadius: '10px',
              background: 'var(--card)', border: '1px solid var(--border)',
              opacity: row.enabled ? 1 : 0.55,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', minWidth: '20px', textAlign: 'right', paddingTop: '2px' }}>{i + 1}.</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {editingId === row.id ? (
                    <textarea
                      value={editingDraft}
                      onChange={(e) => setEditingDraft(e.target.value)}
                      rows={3}
                      style={{
                        width: '100%', boxSizing: 'border-box', padding: '8px',
                        borderRadius: '6px', border: '1px solid var(--border)',
                        background: 'var(--input-bg)', color: 'var(--text-primary)',
                        fontSize: '13px', fontFamily: 'inherit', resize: 'vertical',
                      }}
                    />
                  ) : (
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {row.content}
                    </div>
                  )}
                  <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-muted)' }}>
                    {row.enabled ? 'Active' : 'Disabled'} · added {new Date(row.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flexShrink: 0 }}>
                  {editingId === row.id ? (
                    <>
                      <button onClick={saveEdit} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>Save</button>
                      <button onClick={() => { setEditingId(null); setEditingDraft(''); }} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', cursor: 'pointer' }}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => toggle(row)}
                        style={{
                          padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: row.enabled ? 'rgba(251,191,36,0.1)' : 'rgba(34,197,94,0.1)',
                          border: `1px solid ${row.enabled ? 'rgba(251,191,36,0.3)' : 'rgba(34,197,94,0.3)'}`,
                          color: row.enabled ? '#f59e0b' : '#22c55e',
                          cursor: 'pointer',
                        }}
                      >{row.enabled ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => startEdit(row)} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'transparent', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)', cursor: 'pointer' }}>Edit</button>
                      <button onClick={() => remove(row)} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'transparent', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer' }}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
