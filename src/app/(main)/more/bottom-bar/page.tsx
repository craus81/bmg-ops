'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useNavTabs } from '@/components/useNavTabs';
import { TAB_ICONS } from '@/components/BottomNav';
import { defaultNavTabs, defaultOpenNavTabs, MAX_TABS, MAX_OPEN_TABS, type Tab } from '@/lib/nav-tabs';

/**
 * More → Customize Bottom Bar. Each user picks and orders up to MAX_TABS
 * tabs from the ones their role allows; More always stays at the end.
 * Saved on their profile, so the same bar shows on every device.
 *
 * On an iPhone Duo (or once an open-screen list is saved) a switch adds a
 * second, longer list for the side bar on the OPEN screen (MAX_OPEN_TABS).
 */
export default function BottomBarSettingsPage() {
  const router = useRouter();
  const { saveNavTabs, profile, loading } = useAuth();
  const { available, tabs, openTabs, customerOnly } = useNavTabs();

  // Which list is being edited. The Open screen choice only shows on an
  // iPhone Duo (html[data-sidenav]) or when an open list is already saved.
  const [onDuo, setOnDuo] = useState(false);
  const [which, setWhich] = useState<'bar' | 'open'>('bar');
  useEffect(() => {
    const root = document.documentElement;
    setOnDuo(root.hasAttribute('data-sidenav'));
    if (root.hasAttribute('data-duo-wide')) setWhich('open');
  }, []);
  const showSwitch = onDuo || !!profile?.nav_tabs_open?.length;
  const isOpen = which === 'open';
  const max = isOpen ? MAX_OPEN_TABS : MAX_TABS;

  const [picked, setPicked] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Start from what the chosen list shows now, once the profile has loaded
  // (and again when switching lists).
  useEffect(() => {
    if (loading || ready) return;
    setPicked((isOpen ? openTabs : tabs).map(t => t.id));
    setReady(true);
  }, [loading, ready, tabs, openTabs, isOpen]);
  const switchTo = (w: 'bar' | 'open') => {
    if (w === which) return;
    setWhich(w);
    setReady(false);
    setMessage(null);
  };

  const byId = new Map(available.map(t => [t.id, t]));
  const inBar = picked.map(id => byId.get(id)).filter((t): t is Tab => !!t);
  const notInBar = available
    .filter(t => !picked.includes(t.id))
    .sort((a, b) => a.priority - b.priority);
  const full = inBar.length >= max;
  const isCustom = !!(isOpen ? profile?.nav_tabs_open : profile?.nav_tabs)?.length;

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= picked.length) return;
    const next = [...picked];
    [next[i], next[j]] = [next[j], next[i]];
    setPicked(next);
    setMessage(null);
  };
  const remove = (id: string) => { setPicked(p => p.filter(x => x !== id)); setMessage(null); };
  const add = (id: string) => { if (!full) { setPicked(p => [...p, id]); setMessage(null); } };

  const save = async (ids: string[] | null) => {
    setSaving(true);
    setMessage(null);
    try {
      await saveNavTabs(ids, which);
      if (ids === null) setPicked((isOpen ? defaultOpenNavTabs(available, tabs) : defaultNavTabs(available)).map(t => t.id));
      setMessage({ ok: true, text: ids === null
        ? (isOpen ? 'Back to the default: your bottom bar, then your other pages.' : 'Back to the default bar.')
        : (isOpen ? 'Saved. The open screen’s side bar is updated.' : 'Saved. Your bar is updated on every device.') });
    } catch (err) {
      setMessage({ ok: false, text: `Couldn't save: ${err instanceof Error ? err.message : 'unknown error'}` });
    } finally {
      setSaving(false);
    }
  };

  const sectionLabel: React.CSSProperties = { fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', margin: '18px 0 8px' };
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--card)', boxShadow: 'var(--shadow-sm)' };
  const iconBtn: React.CSSProperties = { width: '36px', height: '36px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-body)', fontSize: '16px', fontWeight: 700, cursor: 'pointer', flexShrink: 0 };

  const label = (t: Tab) => {
    const Icon = TAB_ICONS[t.id];
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
        {Icon && <Icon size={20} strokeWidth={2} />}
        <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>{t.label}</span>
      </div>
    );
  };

  if (customerOnly) {
    return (
      <div style={{ maxWidth: '520px', margin: '0 auto' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>The customer portal bar can’t be customized.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '520px', margin: '0 auto' }}>
      <button onClick={() => router.push('/more')} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600, cursor: 'pointer', padding: 0 }}>← More</button>
      <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: '10px 0 4px' }}>Customize Bottom Bar</h1>
      {showSwitch && (
        <div role="tablist" style={{ display: 'flex', gap: '4px', padding: '4px', margin: '8px 0 10px', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--card)' }}>
          {([['bar', 'Phone bar'], ['open', 'Open screen']] as const).map(([w, text]) => (
            <button
              key={w}
              role="tab"
              aria-selected={which === w}
              onClick={() => switchTo(w)}
              style={{ flex: 1, padding: '8px', borderRadius: '9px', border: 'none', background: which === w ? 'var(--navy, #1e3a8a)' : 'transparent', color: which === w ? '#fff' : 'var(--text-body)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >{text}</button>
          ))}
        </div>
      )}
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        {isOpen
          ? <>The side bar when your iPhone Duo is open. Pick up to {MAX_OPEN_TABS} tabs and put them in the order you want; More always stays at the end. The top of the list is the top of the side bar. The closed phone keeps your Phone bar.</>
          : <>Pick up to {MAX_TABS} tabs and put them in the order you want. More always stays at the end, and everything you leave out is still in More. The top of the list is the left end of the bar.</>}
      </div>

      <div style={sectionLabel}>{isOpen ? 'On the open screen' : 'In your bar'} ({inBar.length}/{max})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {inBar.map((t, i) => (
          <div key={t.id} style={row}>
            {label(t)}
            <button aria-label={`Move ${t.label} up`} disabled={i === 0} onClick={() => move(i, -1)} style={{ ...iconBtn, opacity: i === 0 ? 0.35 : 1 }}>↑</button>
            <button aria-label={`Move ${t.label} down`} disabled={i === inBar.length - 1} onClick={() => move(i, 1)} style={{ ...iconBtn, opacity: i === inBar.length - 1 ? 0.35 : 1 }}>↓</button>
            <button aria-label={`Remove ${t.label}`} onClick={() => remove(t.id)} style={{ ...iconBtn, color: 'var(--error)' }}>✕</button>
          </div>
        ))}
        {inBar.length === 0 && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Add at least one tab below.</div>
        )}
      </div>

      {notInBar.length > 0 && (
        <>
          <div style={sectionLabel}>{isOpen ? 'Not on the open screen' : 'Not in your bar'}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {notInBar.map(t => (
              <div key={t.id} style={row}>
                {label(t)}
                <button aria-label={`Add ${t.label}`} disabled={full} onClick={() => add(t.id)} style={{ ...iconBtn, opacity: full ? 0.35 : 1, color: 'var(--navy-light)' }}>+</button>
              </div>
            ))}
          </div>
          {full && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>{isOpen ? 'The open screen is full.' : 'Your bar is full.'} Remove a tab to add another.</div>}
        </>
      )}

      {message && (
        <div role="status" style={{ marginTop: '14px', fontSize: '12px', fontWeight: 600, color: message.ok ? 'var(--success, #16a34a)' : 'var(--error)' }}>{message.text}</div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
        <button
          onClick={() => save(null)}
          disabled={saving || !isCustom}
          style={{ flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-body)', fontSize: '13px', fontWeight: 700, opacity: saving || !isCustom ? 0.5 : 1 }}
        >Reset to Default</button>
        <button
          onClick={() => save(inBar.map(t => t.id))}
          disabled={saving || inBar.length === 0}
          style={{ flex: 1, padding: '12px', borderRadius: '10px', border: 'none', background: 'var(--navy, #1e3a8a)', color: '#fff', fontSize: '13px', fontWeight: 700, opacity: saving || inBar.length === 0 ? 0.5 : 1 }}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}
