'use client';

/**
 * One @mention: the full note, who wrote it and where, and an Open button
 * when this person's role can open the note's record. Every mention
 * notification (push, email, bell) and every Mentions list row lands here.
 *
 * Before this screen, a mention linked straight to the record page, and a
 * teammate whose role couldn't open that page (a PO, an estimate for
 * Graphics Production, the at-risk report) was bounced to /home, where the
 * Mentions card only showed the excerpt — they could never read the note.
 * The row is read with the viewer's own session; RLS (migration 159) only
 * returns mentions addressed to them.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { mentionUrl, type Mention } from '@/lib/use-mentions';
import { canOpenMentionUrl } from '@/lib/mention-access';

export default function MentionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const { user, profile, hasFeature, loading: authLoading } = useAuth();
  const [mention, setMention] = useState<Mention | null>(null);
  const [author, setAuthor] = useState<string>('A teammate');
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    if (authLoading || !user?.id || !id) return;
    (async () => {
      const { data } = await supabase
        .from('note_mentions')
        .select('id, mentioned_by, source_type, source_id, context_label, context_url, note_excerpt, read_at, created_at')
        .eq('id', id)
        .maybeSingle();
      if (!data) { setState('missing'); return; }
      const m = data as Mention;
      setMention(m);
      setState('ready');
      if (m.mentioned_by) {
        const { data: p } = await supabase.from('profiles').select('full_name').eq('id', m.mentioned_by).maybeSingle();
        if (p?.full_name) setAuthor(p.full_name);
      }
      if (!m.read_at) {
        await supabase.from('note_mentions').update({ read_at: new Date().toISOString() }).eq('id', m.id);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [authLoading, user?.id, id]);

  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const target = mention ? mentionUrl(mention) : null;
  const canOpen = canOpenMentionUrl(target, roles, hasFeature);

  const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px' } as const;

  if (state === 'loading') {
    return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>;
  }

  if (state === 'missing' || !mention) {
    return (
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>
        <div style={card}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>This mention isn’t available</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
            It may have been sent to a different account.
          </div>
          <button onClick={() => router.push('/home')} style={{ marginTop: '12px', padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>
            Go to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '640px', margin: '0 auto' }}>
      <div style={card}>
        <div style={{ fontSize: '12px', fontWeight: 800, color: '#60a5fa' }}>＠ Mention</div>
        <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '6px' }}>
          {author} mentioned you{mention.context_label ? ` on ${mention.context_label}` : ''}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
          {new Date(mention.created_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </div>
        <div style={{ fontSize: '14px', color: 'var(--text-primary)', marginTop: '14px', whiteSpace: 'pre-wrap', lineHeight: 1.5, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '12px' }}>
          {mention.note_excerpt || '(No note text was saved with this mention.)'}
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
          {canOpen && target && (
            <button onClick={() => router.push(target)} style={{ padding: '9px 16px', borderRadius: '8px', border: 'none', background: 'var(--navy)', color: '#fff', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>
              Open {mention.context_label || 'record'}
            </button>
          )}
          <button onClick={() => router.push('/home')} style={{ padding: '9px 16px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>
            Back to Home
          </button>
        </div>
        {!canOpen && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' }}>
            Your account can’t open the page this note was written on, so the whole note is shown here. Reply to {author} if you need more.
          </div>
        )}
      </div>
    </div>
  );
}
