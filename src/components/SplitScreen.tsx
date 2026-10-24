'use client';

/**
 * Split screen: two pages at once (src/lib/split-screen.ts has the rules).
 *
 * SplitScreenProvider decides whether it's on and remembers both panes'
 * pages; SplitPanes draws them, one frame per pane, with the line between
 * them at the middle of the screen (on the crease of the open iPhone Duo).
 * The header's Split button and the tab bar read the same context.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useDuoWide } from '@/components/useDuoWide';
import { useNavTabs } from '@/components/useNavTabs';
import { useAuth } from '@/components/AuthProvider';
import { AI_TAB_ID } from '@/lib/nav-tabs';
import { getTextZoom } from '@/lib/text-size';
import {
  defaultSplitState, otherPane, paneAt, paneName, parseSplitState, safePaneUrl, splitAvailable, splitDirection, splitOn,
  SPLIT_STORAGE_KEY, type HostMessage, type PaneId, type PaneMessage, type PaneRect, type SplitState,
} from '@/lib/split-screen';

interface SplitCtx {
  /** Split screen is showing. */
  on: boolean;
  /** The Split button belongs on this screen. */
  available: boolean;
  toggle: () => void;
  /** Open a page in the pane touched last. */
  go: (url: string) => void;
  /** The page in the pane touched last (for the tab bar's highlight). */
  activePath: string;
}

const Ctx = createContext<SplitCtx>({ on: false, available: false, toggle: () => {}, go: () => {}, activePath: '' });
export const useSplitScreen = () => useContext(Ctx);

interface PanesCtx {
  state: SplitState;
  setActive: (p: PaneId) => void;
  setPaneUrl: (p: PaneId, url: string) => void;
  goPane: (p: PaneId, url: string) => void;
  register: (p: PaneId, frame: HTMLIFrameElement | null) => void;
  srcs: Record<PaneId, string>;
  direction: 'columns' | 'rows';
}
const PanesContext = createContext<PanesCtx | null>(null);


function readState(): { state: SplitState; saved: boolean } {
  try {
    const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
    return { state: parseSplitState(raw), saved: !!raw };
  } catch {
    return { state: defaultSplitState(), saved: false };
  }
}

export function SplitScreenProvider({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const duoWide = useDuoWide();
  const [state, setState] = useState<SplitState>(defaultSplitState);
  const savedRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [screen, setScreen] = useState({ w: 0, h: 0, cssW: 0 });
  // Hard loads of a pane (first show, or before it has said it's ready).
  const [srcs, setSrcs] = useState<Record<PaneId, string>>(state.urls);
  const frames = useRef<Record<PaneId, HTMLIFrameElement | null>>({ a: null, b: null });
  const ready = useRef<Record<PaneId, boolean>>({ a: false, b: false });
  // The panes show once their pages are settled, so a frame doesn't load one
  // page and then another.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const r = readState();
    savedRef.current = r.saved;
    setState(r.state);
    setSrcs(r.state.urls);
    setLoaded(true);
    const measure = () => setScreen({ w: window.innerWidth, h: window.innerHeight, cssW: window.innerWidth / getTextZoom() });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }, [state, loaded]);

  const on = !disabled && loaded && splitOn(duoWide, screen.cssW, state.choice);
  const available = !disabled && splitAvailable(duoWide, screen.cssW);

  useEffect(() => {
    document.documentElement.toggleAttribute('data-split', on);
    return () => document.documentElement.removeAttribute('data-split');
  }, [on]);


  const currentUrl = () => window.location.pathname + window.location.search + window.location.hash;

  // Turning on: the page you were on goes in the pane you used last (the
  // very first time it's Graphics Builder | Client Files). Turning off (or
  // folding the phone): you land on the page you touched last.
  const wasOn = useRef(false);
  const parentUrl = useRef('');
  useEffect(() => {
    if (!loaded) return;
    if (on && !wasOn.current) {
      const here = safePaneUrl(currentUrl());
      const s = state;
      const next = savedRef.current && here && here !== s.urls.a && here !== s.urls.b
        ? { ...s, urls: { ...s.urls, [s.active]: here } }
        : s;
      setState(next);
      setSrcs(next.urls);
      setShown(true);
      ready.current = { a: false, b: false };
      savedRef.current = true;
      parentUrl.current = currentUrl();
    } else if (!on && wasOn.current) {
      setShown(false);
      const target = state.urls[state.active];
      if (target && target !== currentUrl()) router.replace(target);
    }
    wasOn.current = on;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on the on/off edge
  }, [on, loaded]);

  const send = useCallback((p: PaneId, msg: HostMessage) => {
    const w = frames.current[p]?.contentWindow;
    if (w) w.postMessage(msg, window.location.origin);
  }, []);

  const goPane = useCallback((p: PaneId, raw: string) => {
    const url = safePaneUrl(raw);
    if (!url) return;
    setState(s => ({ ...s, urls: { ...s.urls, [p]: url } }));
    if (ready.current[p]) send(p, { type: 'fs-host-go', url });
    else setSrcs(s => ({ ...s, [p]: url }));
  }, [send]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const go = useCallback((url: string) => goPane(stateRef.current.active, url), [goPane]);

  // While split, a page the header opens (Chat, the logo, a search result)
  // goes into the pane touched last instead.
  useEffect(() => {
    if (!on) return;
    const check = () => {
      const here = currentUrl();
      if (here === parentUrl.current) return;
      parentUrl.current = here;
      go(here);
    };
    check();
    const t = window.setInterval(check, 500);
    return () => window.clearInterval(t);
  }, [on, pathname, go]);

  const toggle = useCallback(() => {
    setState(s => ({ ...s, choice: on ? 'off' : 'on' }));
  }, [on]);

  const setActive = useCallback((p: PaneId) => setState(s => (s.active === p ? s : { ...s, active: p })), []);
  const setPaneUrl = useCallback((p: PaneId, url: string) => {
    ready.current[p] = true;
    setState(s => (s.urls[p] === url ? s : { ...s, urls: { ...s.urls, [p]: url } }));
  }, []);
  const register = useCallback((p: PaneId, frame: HTMLIFrameElement | null) => {
    frames.current[p] = frame;
    if (!frame) ready.current[p] = false;
  }, []);

  const ctx = useMemo<SplitCtx>(() => ({
    on: on && shown, available, toggle, go, activePath: (state.urls[state.active] || '').split(/[?#]/)[0],
  }), [on, shown, available, toggle, go, state.urls, state.active]);

  const panes = useMemo<PanesCtx>(() => ({
    state, setActive, setPaneUrl, goPane, register, srcs, direction: splitDirection(screen.w, screen.h),
  }), [state, setActive, setPaneUrl, goPane, register, srcs, screen.w, screen.h]);

  return (
    <Ctx.Provider value={ctx}>
      <PanesContext.Provider value={panes}>{children}</PanesContext.Provider>
    </Ctx.Provider>
  );
}

/** Pages offered in a pane's own picker. */
function usePickerPages(): { path: string; label: string }[] {
  const { available } = useNavTabs();
  const { hasFeature } = useAuth();
  return useMemo(() => {
    const pages = available.filter(t => t.id !== AI_TAB_ID && t.path).map(t => ({ path: t.path, label: t.label }));
    if (hasFeature('graphics_builder')) pages.push({ path: '/admin/wrap-quote', label: 'Graphics Builder' });
    pages.push({ path: '/client-files', label: 'Client Files' }, { path: '/more', label: 'More' });
    const seen = new Set<string>();
    return pages.filter(p => (seen.has(p.path) ? false : (seen.add(p.path), true)));
  }, [available, hasFeature]);
}

const GAP = 12; // the divider, centred on the crease

export function SplitPanes() {
  const panes = useContext(PanesContext);
  const areaRef = useRef<HTMLDivElement>(null);
  const wrapRefs = useRef<Record<PaneId, HTMLDivElement | null>>({ a: null, b: null });
  const frameRefs = useRef<Record<PaneId, HTMLIFrameElement | null>>({ a: null, b: null });
  const [drag, setDrag] = useState<{ from: PaneId; id: string; name: string; x: number; y: number; over: PaneId | null } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const pages = usePickerPages();

  // Where each pane's frame sits in the split area, in the area's px.
  const frameRects = useCallback((): Record<PaneId, PaneRect> => {
    const r = (p: PaneId): PaneRect => {
      const w = wrapRefs.current[p], f = frameRefs.current[p];
      if (!w || !f) return { left: 0, top: 0, width: 0, height: 0 };
      return { left: w.offsetLeft + f.offsetLeft, top: w.offsetTop + f.offsetTop, width: f.offsetWidth, height: f.offsetHeight };
    };
    return { a: r('a'), b: r('b') };
  }, []);

  const drop = useCallback((d: NonNullable<typeof drag>) => {
    setDrag(null);
    if (d.over && d.over !== d.from && panes) {
      panes.setActive(d.over);
      const w = frameRefs.current[d.over]?.contentWindow;
      w?.postMessage({ type: 'fs-host-open-client-file', id: d.id } satisfies HostMessage, window.location.origin);
    }
  }, [panes]);

  useEffect(() => {
    if (!panes) return;
    const paneOf = (src: MessageEventSource | null): PaneId | null => {
      if (src && src === frameRefs.current.a?.contentWindow) return 'a';
      if (src && src === frameRefs.current.b?.contentWindow) return 'b';
      return null;
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const p = paneOf(e.source);
      if (!p) return;
      const msg = e.data as PaneMessage;
      if (msg?.type === 'fs-pane-url') {
        const url = safePaneUrl(msg.url);
        if (url) panes.setPaneUrl(p, url);
      } else if (msg?.type === 'fs-pane-touch') {
        panes.setActive(p);
      } else if (msg?.type === 'fs-pane-send-client-file' && typeof msg.id === 'string') {
        const other = otherPane(p);
        frameRefs.current[other]?.contentWindow?.postMessage(
          { type: 'fs-host-open-client-file', id: msg.id } satisfies HostMessage, window.location.origin,
        );
      } else if (msg?.type === 'fs-pane-drag') {
        const rect = frameRects()[p];
        const x = rect.left + msg.fx * rect.width;
        const y = rect.top + msg.fy * rect.height;
        const over = paneAt(x, y, frameRects());
        if (msg.phase === 'start' && msg.id) {
          setDrag({ from: p, id: msg.id, name: msg.name || 'File', x, y, over });
        } else if (msg.phase === 'move') {
          setDrag(d => (d ? { ...d, x, y, over } : d));
        } else if (msg.phase === 'end') {
          const d = dragRef.current;
          if (d) drop({ ...d, x, y, over });
        } else {
          setDrag(null);
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [panes, frameRects, drop]);

  // A mouse that leaves the frame it started in reports here instead.
  useEffect(() => {
    if (!drag) return;
    const toArea = (e: MouseEvent) => {
      const area = areaRef.current;
      const ts = getTextZoom();
      return { x: e.clientX / ts - (area?.offsetLeft ?? 0), y: e.clientY / ts - (area?.offsetTop ?? 0) };
    };
    const onMove = (e: MouseEvent) => {
      const { x, y } = toArea(e);
      setDrag(d => (d ? { ...d, x, y, over: paneAt(x, y, frameRects()) } : d));
    };
    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const { x, y } = toArea(e);
      drop({ ...d, x, y, over: paneAt(x, y, frameRects()) });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [drag, frameRects, drop]);

  if (!panes) return null;
  const { state, srcs, direction } = panes;
  const cols = direction === 'columns';
  // The divider sits on the middle of the screen: the crease of the open Duo.
  const half = cols ? `calc(50vw / var(--ts) - ${GAP / 2}px)` : `calc(50vh / var(--ts) - var(--hdr-h, 60px) - ${GAP / 2}px)`;
  const after = cols ? `calc(50vw / var(--ts) + ${GAP / 2}px)` : `calc(50vh / var(--ts) - var(--hdr-h, 60px) + ${GAP / 2}px)`;

  const paneStyle = (p: PaneId): React.CSSProperties => {
    const first = p === 'a';
    const base: React.CSSProperties = {
      position: 'absolute', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: 'var(--bg)', boxSizing: 'border-box',
      border: `2px solid ${drag?.over === p && drag.from !== p ? 'var(--success, #16a34a)' : state.active === p ? 'rgba(59,130,246,0.55)' : 'transparent'}`,
      borderRadius: '6px',
    };
    return cols
      ? { ...base, top: 0, bottom: 0, ...(first ? { left: 0, width: half } : { left: after, right: 0 }) }
      : { ...base, left: 0, right: 0, ...(first ? { top: 0, height: half } : { top: after, bottom: 0 }) };
  };

  const pickerValue = (url: string) => {
    const path = url.split(/[?#]/)[0];
    const hit = pages.find(pg => path === pg.path.split('?')[0] || path.startsWith(pg.path.split('?')[0] + '/'));
    return hit?.path ?? '';
  };

  return (
    <div
      ref={areaRef}
      className="split-area"
      style={{
        position: 'fixed', zIndex: 50, left: 0,
        top: 'var(--hdr-h, 60px)', right: 'var(--split-right, 0px)', bottom: 'var(--split-bottom, 70px)',
        background: 'var(--border-strong)',
      }}
    >
      {(['a', 'b'] as PaneId[]).map(p => (
        <div key={p} ref={el => { wrapRefs.current[p] = el; }} style={paneStyle(p)} onPointerDown={() => panes.setActive(p)}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', flexShrink: 0,
            background: 'var(--card)', borderBottom: '1px solid var(--border)',
          }}>
            <select
              id={`split-pane-${p}`}
              aria-label={p === 'a' ? 'Page on the first side' : 'Page on the second side'}
              value={pickerValue(state.urls[p])}
              onChange={e => { panes.setActive(p); if (e.target.value) panes.goPane(p, e.target.value); }}
              style={{
                fontSize: '13px', fontWeight: 800, color: 'var(--text-label)', background: 'var(--bg)',
                border: '1px solid var(--border-strong)', borderRadius: '8px', padding: '4px 8px', maxWidth: '100%',
              }}
            >
              {!pickerValue(state.urls[p]) && <option value="">This page</option>}
              {pages.map(pg => <option key={pg.path} value={pg.path}>{pg.label}</option>)}
            </select>
          </div>
          <iframe
            ref={el => { frameRefs.current[p] = el; panes.register(p, el); }}
            name={paneName(p)}
            src={srcs[p]}
            title={p === 'a' ? 'First side' : 'Second side'}
            style={{ flex: 1, width: '100%', border: 'none', display: 'block', background: 'var(--bg)' }}
          />
        </div>
      ))}
      {/* The divider, on the crease. */}
      <div aria-hidden="true" style={{
        position: 'absolute', display: 'flex', alignItems: 'center', justifyContent: 'center',
        ...(cols ? { top: 0, bottom: 0, left: half, width: `${GAP}px` } : { left: 0, right: 0, top: half, height: `${GAP}px` }),
      }}>
        <div style={{ background: 'var(--text-muted)', opacity: 0.4, borderRadius: '3px', ...(cols ? { width: '4px', height: '44px' } : { width: '44px', height: '4px' }) }} />
      </div>
      {drag && (
        // Over the frames so a mouse drag keeps reporting here, and so the
        // file in hand shows on either side.
        <div style={{ position: 'absolute', inset: 0, zIndex: 3, cursor: 'grabbing', touchAction: 'none' }}>
          <div style={{
            position: 'absolute', left: drag.x, top: drag.y, transform: 'translate(-50%, -120%)', pointerEvents: 'none',
            background: 'var(--card)', border: `2px solid ${drag.over && drag.over !== drag.from ? 'var(--success, #16a34a)' : 'var(--accent, #2563eb)'}`,
            borderRadius: '10px', padding: '8px 12px', boxShadow: '0 6px 20px rgba(0,0,0,0.25)', maxWidth: '260px',
            fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)',
          }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {drag.name}</div>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginTop: '2px' }}>
              {drag.over && drag.over !== drag.from ? 'Let go to open it in the Graphics Builder' : 'Drag to the other side'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
