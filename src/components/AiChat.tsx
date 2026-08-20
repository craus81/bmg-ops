'use client';

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { createClient } from '@/lib/supabase-browser';
import { getTextZoom } from '@/lib/text-size';

// Keep the prompt + history under a sane token budget by only sending
// the most recent N exchanges to the model. The full transcript still
// lives in the DB and renders in the chat UI.
const HISTORY_SEND_LIMIT = 20;
// On chat open, hydrate at most this many rows from the DB. Older messages
// stay queryable but aren't rendered until the user scrolls back if/when
// we add that later.
const HISTORY_LOAD_LIMIT = 200;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  loading?: boolean;
}

// Parse an assistant message into alternating text and markdown-table
// segments. A markdown table is a header line | a | b |, a separator
// line | --- | --- |, and 1+ data rows. Anything else stays as text.
type Segment = { type: 'text'; text: string } | { type: 'table'; headers: string[]; rows: string[][] };

function splitPipeRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function isSeparator(line: string): boolean {
  const cells = splitPipeRow(line);
  if (cells.length === 0) return false;
  return cells.every(c => /^:?-+:?$/.test(c));
}

function parseMessageSegments(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let buffer: string[] = [];
  const flushText = () => {
    if (buffer.length === 0) return;
    const t = buffer.join('\n').replace(/^\n+|\n+$/g, '');
    if (t) segments.push({ type: 'text', text: t });
    buffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const nextLine = lines[i + 1] || '';
    const looksLikeHeader = /^\s*\|/.test(line) && line.trim().endsWith('|');
    if (looksLikeHeader && isSeparator(nextLine)) {
      // Start of a table
      flushText();
      const headers = splitPipeRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const row = lines[i];
        if (!/^\s*\|/.test(row) || !row.trim().endsWith('|')) break;
        rows.push(splitPipeRow(row));
        i++;
      }
      segments.push({ type: 'table', headers, rows });
      continue;
    }
    buffer.push(line);
    i++;
  }
  flushText();
  return segments;
}

function rowsToCsv(headers: string[], rows: string[][]): string {
  const escape = (s: string) => {
    const v = s ?? '';
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
}

function MessageBody({ text }: { text: string }) {
  const segments = parseMessageSegments(text);

  // Trigger a browser CSV download. Built on the standard
  // Blob + ObjectURL + temporary anchor pattern so it works
  // across every browser without a server round-trip.
  const downloadCsv = (idx: number, headers: string[], rows: string[][]) => {
    try {
      const csv = rowsToCsv(headers, rows);
      // Excel needs a UTF-8 BOM to open special characters cleanly.
      const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').split('Z')[0];
      a.download = `fleetsuite-ai-table-${idx + 1}-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Slight delay before revoking so Safari finishes the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error('[ai chat] CSV download failed:', err);
    }
  };

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return (
            <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{seg.text}</div>
          );
        }
        return (
          <div key={i} style={{ margin: '6px 0' }}>
            <div style={{ overflowX: 'auto', borderRadius: '6px', border: '1px solid var(--border)' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '11px', width: '100%' }}>
                <thead>
                  <tr style={{ background: 'rgba(59,130,246,0.08)' }}>
                    {seg.headers.map((h, j) => (
                      <th key={j} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 700, color: 'var(--text-primary)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {seg.rows.map((r, ri) => (
                    <tr key={ri} style={{ borderBottom: '1px solid var(--border)' }}>
                      {seg.headers.map((_, ci) => (
                        <td key={ci} style={{ padding: '5px 8px', color: 'var(--text-body)', verticalAlign: 'top' }}>{r[ci] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button
                onClick={() => downloadCsv(i, seg.headers, seg.rows)}
                title="Download this table as a .csv file"
                style={{
                  padding: '3px 9px', borderRadius: '6px',
                  background: 'rgba(59,130,246,0.1)',
                  border: '1px solid rgba(59,130,246,0.25)',
                  color: '#60a5fa',
                  fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                }}
              >Download CSV</button>
            </div>
          </div>
        );
      })}
    </>
  );
}

function MascotSvg({ thinking, size = 52 }: { thinking?: boolean; size?: number }) {
  const t = thinking;
  // When thinking: eyes pulse fast and bright, reactor spins/pulses intensely
  // When idle: gentle slow breathing animations
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="60 20 140 160" width={size} height={size}>
      <defs>
        <linearGradient id="hm" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#1e3a8a' }} />
          <stop offset="50%" style={{ stopColor: '#172554' }} />
          <stop offset="100%" style={{ stopColor: '#0f1b3d' }} />
        </linearGradient>
        <linearGradient id="hs" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#172554' }} />
          <stop offset="100%" style={{ stopColor: '#0c1533' }} />
        </linearGradient>
        <linearGradient id="fp" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#ea580c' }} />
          <stop offset="100%" style={{ stopColor: '#c2410c' }} />
        </linearGradient>
        <linearGradient id="eg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#bfdbfe' }} />
          <stop offset="100%" style={{ stopColor: '#93c5fd' }} />
        </linearGradient>
        <filter id="ef">
          <feGaussianBlur stdDeviation={t ? '4' : '3'} result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="rg">
          <feGaussianBlur stdDeviation={t ? '8' : '5'} result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="sh">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.6" />
        </filter>
      </defs>

      {/* Helmet base */}
      <g filter="url(#sh)">
        <path d="M 85 75 Q 85 35 130 28 Q 175 35 175 75 L 175 95 Q 175 102 168 108 L 155 118 L 145 128 L 130 135 L 115 128 L 105 118 L 92 108 Q 85 102 85 95 Z" fill="url(#hm)" />

        {/* Faceplate - continuous orange from top to chin */}
        <path d="M 115 28 Q 122 26 130 26 Q 138 26 145 28 L 145 75 L 164 76 L 163 100 L 155 114 L 147 125 L 130 133 L 113 125 L 105 114 L 97 100 L 96 76 L 115 75 Z" fill="url(#fp)" />

        {/* Center ridge */}
        <line x1="130" y1="28" x2="130" y2="100" stroke="#c2410c" strokeWidth="1" opacity="0.35" />

        {/* Top highlight */}
        <path d="M 118 30 Q 124 28 130 28 Q 136 28 140 30 L 140 50 L 120 50 Z" fill="rgba(255,255,255,0.1)" />

        {/* Side panels */}
        <path d="M 86 73 L 93 70 L 93 98 L 87 102 Z" fill="url(#hs)" />
        <path d="M 174 73 L 167 70 L 167 98 L 173 102 Z" fill="url(#hs)" />

        {/* Side detail */}
        <path d="M 87 82 L 93 80" stroke="#1e3a8a" strokeWidth="1" opacity="0.4" />
        <path d="M 87 87 L 93 85" stroke="#1e3a8a" strokeWidth="1" opacity="0.4" />
        <path d="M 173 82 L 167 80" stroke="#1e3a8a" strokeWidth="1" opacity="0.4" />
        <path d="M 173 87 L 167 85" stroke="#1e3a8a" strokeWidth="1" opacity="0.4" />

        {/* Chin V */}
        <path d="M 118 123 L 130 131 L 142 123" fill="none" stroke="#9a3412" strokeWidth="1.5" opacity="0.6" />

        {/* Mouth slit */}
        <path d="M 114 117 L 146 117" fill="none" stroke="#9a3412" strokeWidth="2" strokeLinecap="round" />

        {/* Eyes */}
        <g filter="url(#ef)">
          {/* Sockets */}
          <path d="M 97 80 L 124 85 L 123.5 89 L 96.5 83 Z" fill="#060d1f" />
          <path d="M 163 80 L 136 85 L 136.5 89 L 163.5 83 Z" fill="#060d1f" />

          {/* Eye glow */}
          <path d="M 98 81 L 122 85.5 L 121.7 88 L 97.5 82.5 Z" fill="url(#eg)" opacity="0.95" />
          <path d="M 162 81 L 138 85.5 L 138.3 88 L 162.5 82.5 Z" fill="url(#eg)" opacity="0.95" />

          {/* Eye pulse - fast when thinking */}
          <path d="M 98 81 L 122 85.5 L 121.7 88 L 97.5 82.5 Z" fill={t ? '#93c5fd' : '#60a5fa'} opacity="0.2">
            <animate attributeName="opacity" values={t ? '0.3;0.9;0.3' : '0.2;0.5;0.2'} dur={t ? '0.6s' : '2.5s'} repeatCount="indefinite" />
          </path>
          <path d="M 162 81 L 138 85.5 L 138.3 88 L 162.5 82.5 Z" fill={t ? '#93c5fd' : '#60a5fa'} opacity="0.2">
            <animate attributeName="opacity" values={t ? '0.3;0.9;0.3' : '0.2;0.5;0.2'} dur={t ? '0.6s' : '2.5s'} repeatCount="indefinite" begin={t ? '0.3s' : '1.2s'} />
          </path>

          {/* Extra bright eye overlay when thinking */}
          {t && (
            <>
              <path d="M 98 81 L 122 85.5 L 121.7 88 L 97.5 82.5 Z" fill="#fff" opacity="0.15">
                <animate attributeName="opacity" values="0.15;0.5;0.15" dur="0.8s" repeatCount="indefinite" />
              </path>
              <path d="M 162 81 L 138 85.5 L 138.3 88 L 162.5 82.5 Z" fill="#fff" opacity="0.15">
                <animate attributeName="opacity" values="0.15;0.5;0.15" dur="0.8s" repeatCount="indefinite" begin="0.4s" />
              </path>
            </>
          )}
        </g>

        {/* Brow ridge */}
        <path d="M 95 78 L 125 83 L 130 82 L 135 83 L 165 78" fill="none" stroke="#0c1533" strokeWidth="2.5" strokeLinecap="round" />
      </g>

      {/* Arc reactor - below head, visible at bottom */}
      <g filter="url(#rg)" transform="translate(130, 165)">
        {/* Outer ring */}
        <circle cx="0" cy="0" r="14" fill="none" stroke="#3b82f6" strokeWidth="1" opacity="0.35">
          <animate attributeName="opacity" values={t ? '0.5;1;0.5' : '0.35;0.6;0.35'} dur={t ? '0.5s' : '3s'} repeatCount="indefinite" />
        </circle>
        {/* Housing */}
        <circle cx="0" cy="0" r="12" fill="#060d1f" stroke="#1e3a8a" strokeWidth="1" />
        <circle cx="0" cy="0" r="10" fill="#0a1128" />

        {/* Sideways B logo */}
        <g transform="scale(0.025) translate(-386, -276)" opacity="0.95">
          <path fill="#ea580c" d="M63.4,515.9c-17.2,0-30.8-13.9-31-31.7c0-8.3,3.1-16.1,8.9-21.9c5.8-5.8,13.5-9.1,21.9-9.3l290-1.9l-23-29.8 c-31.1-40.2-48.4-90.7-48.7-142.4C280.6,149.1,385.4,42.7,515.2,41.7c130,0,236.2,105,237.2,233.9c0.4,62.7-23.8,121.9-68.1,166.7 C640,487.2,581,512.2,518.5,512.6l-455,3.1l0,0L63.4,515.9z M512,104.8c-44.7,1.2-86.5,19.3-118,51.3 c-32.3,32.9-50.1,76.2-49.7,122.4c0.6,94.6,77.6,171.6,171.6,171.6c48.4-0.4,91.1-18,124-51.3c32.5-32.9,50.1-76.2,49.7-122.4 c-0.6-93.6-76.6-170-169.6-171.6h-7.7L512,104.8z" />
        </g>

        {/* Reactor pulse */}
        <circle cx="0" cy="0" r="10" fill="#ea580c" opacity="0.06">
          <animate attributeName="opacity" values={t ? '0.1;0.4;0.1' : '0.06;0.15;0.06'} dur={t ? '0.4s' : '2s'} repeatCount="indefinite" />
        </circle>
        <circle cx="0" cy="0" r="8" fill="#3b82f6" opacity="0.05">
          <animate attributeName="r" values={t ? '8;14;8' : '8;10;8'} dur={t ? '0.6s' : '3s'} repeatCount="indefinite" />
          <animate attributeName="opacity" values={t ? '0.1;0.3;0.1' : '0.05;0.1;0.05'} dur={t ? '0.6s' : '3s'} repeatCount="indefinite" />
        </circle>

        {/* Spinning ring when thinking */}
        {t && (
          <circle cx="0" cy="0" r="13" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="6 12" opacity="0.6">
            <animateTransform attributeName="transform" type="rotate" values="0;360" dur="1.5s" repeatCount="indefinite" />
          </circle>
        )}
      </g>
    </svg>
  );
}

export default function AiChat() {
  const { user, isAdmin, isSales, isGraphicsProduction, isInstaller, profile } = useAuth();
  const dialog = useDialog();
  const hasAccess = isAdmin || isSales || isGraphicsProduction || isInstaller;
  const supabase = createClient();
  const [isOpen, setIsOpen] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Hydrate the conversation from Supabase the first time the chat is
  // opened. RLS scopes the rows to the current user automatically.
  useEffect(() => {
    if (!isOpen || historyLoaded || !user?.id) return;
    (async () => {
      const { data } = await supabase
        .from('ai_chat_history')
        .select('role, content, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LOAD_LIMIT);
      const rows = (data || []).reverse();
      if (rows.length > 0) {
        setMessages(rows.map((r: any) => ({ role: r.role, content: r.content })));
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'auto' }), 50);
      }
      setHistoryLoaded(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot hydration
  }, [isOpen, user?.id]);

  // Persist a single turn (user + assistant) to ai_chat_history. RLS lets
  // each user only write rows tagged with their own user_id.
  const persistTurn = async (userText: string, assistantText: string) => {
    if (!user?.id) return;
    try {
      await supabase.from('ai_chat_history').insert([
        { user_id: user.id, role: 'user', content: userText },
        { user_id: user.id, role: 'assistant', content: assistantText },
      ]);
    } catch (err) {
      console.error('[ai chat] persist failed:', err);
    }
  };

  // Draggable position
  const [pos, setPos] = useState({ x: -1, y: -1 }); // -1 = use default
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; dragging: boolean }>({ startX: 0, startY: 0, origX: 0, origY: 0, dragging: false });

  // pos is in CSS px inside the text-size-zoomed page, while clientX/Y and
  // window.innerWidth/Height are real viewport px — divide the real px by
  // the zoom factor so the button tracks the finger and clamps on-screen.
  const getDefaultPos = () => {
    const z = getTextZoom();
    return { x: window.innerWidth / z - 84, y: window.innerHeight / z - 148 };
  };
  const getPos = () => pos.x < 0 ? getDefaultPos() : pos;

  const handleDragStart = (clientX: number, clientY: number) => {
    const p = getPos();
    dragRef.current = { startX: clientX, startY: clientY, origX: p.x, origY: p.y, dragging: false };
  };

  const handleDragMove = (clientX: number, clientY: number) => {
    const d = dragRef.current;
    const z = getTextZoom();
    const dx = (clientX - d.startX) / z;
    const dy = (clientY - d.startY) / z;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) d.dragging = true;
    if (d.dragging) {
      setPos({
        x: Math.max(0, Math.min(window.innerWidth / z - 72, d.origX + dx)),
        y: Math.max(0, Math.min(window.innerHeight / z - 72, d.origY + dy)),
      });
    }
  };

  const handleDragEnd = () => {
    if (!dragRef.current.dragging) {
      setIsOpen(true);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  if (!hasAccess) return null;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setInput('');
    const userMsg: ChatMessage = { role: 'user', content: text };
    const loadingMsg: ChatMessage = { role: 'assistant', content: '', loading: true };

    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setSending(true);
    setTimeout(scrollToBottom, 50);

    let assistantReply = '';
    try {
      const history = [...messages, userMsg]
        .filter(m => !m.loading)
        .slice(-HISTORY_SEND_LIMIT)
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch('/api/ai-agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Role is resolved server-side from the session; sending it from the
        // client was the access bypass (a client could claim any role).
        body: JSON.stringify({ messages: history }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        assistantReply = data.error || 'Something went wrong. Try again.';
      } else {
        assistantReply = data.reply || '';
      }
    } catch {
      assistantReply = 'Network error. Check your connection and try again.';
    }

    setMessages(prev => [
      ...prev.filter(m => !m.loading),
      { role: 'assistant', content: assistantReply },
    ]);
    setSending(false);
    setTimeout(scrollToBottom, 50);

    // Persist after the bubble is on screen so it doesn't feel like the
    // network round-trip blocks rendering. Errors are logged but
    // intentionally don't block the UI.
    persistTurn(text, assistantReply);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // "New Chat" deletes the persistent history for this user so the next
  // turn starts fresh. We confirm because chat memory survives sessions
  // and accidental clears would be costly.
  const clearChat = async () => {
    if (!(await dialog.confirm('Start a new chat? This deletes your saved conversation history.', { destructive: true, confirmLabel: 'New Chat' }))) return;
    setMessages([]);
    if (user?.id) {
      try {
        await supabase.from('ai_chat_history').delete().eq('user_id', user.id);
      } catch (err) {
        console.error('[ai chat] clear history failed:', err);
      }
    }
  };

  return (
    <>
      {/* Floating mascot button */}
      {!isOpen && (
        <div
          onMouseDown={e => { handleDragStart(e.clientX, e.clientY); const onMove = (ev: MouseEvent) => handleDragMove(ev.clientX, ev.clientY); const onUp = () => { handleDragEnd(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }; window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); }}
          onTouchStart={e => { const t = e.touches[0]; handleDragStart(t.clientX, t.clientY); }}
          onTouchMove={e => { const t = e.touches[0]; handleDragMove(t.clientX, t.clientY); }}
          onTouchEnd={() => handleDragEnd()}
          style={{
            position: 'fixed',
            left: `${getPos().x}px`,
            top: `${getPos().y}px`,
            width: '72px',
            height: '72px',
            borderRadius: '50%',
            background: 'var(--card)',
            border: '2px solid var(--border-strong, rgba(255,255,255,0.1))',
            cursor: 'grab',
            boxShadow: '0 4px 20px rgba(30,58,138,0.5)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            touchAction: 'none',
            userSelect: 'none',
            padding: 0,
            overflow: 'hidden',
            transition: 'transform 0.2s, box-shadow 0.2s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'scale(1.1)';
            e.currentTarget.style.boxShadow = '0 4px 24px rgba(59,130,246,0.5)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.boxShadow = '0 4px 20px rgba(30,58,138,0.5)';
          }}
        >
          <MascotSvg thinking={sending} size={62} />
        </div>
      )}

      {/* Chat panel */}
      {isOpen && (
        <div style={isFullScreen ? {
          // Full-screen mode: cover the page content area but leave the
          // sticky header and bottom nav visible (Ashley's spec).
          position: 'fixed',
          top: '72px',
          bottom: '72px',
          left: '12px',
          right: '12px',
          borderRadius: '16px',
          background: 'var(--card)',
          border: '1px solid var(--border)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        } : {
          position: 'fixed',
          bottom: '80px',
          right: '12px',
          width: '340px',
          maxWidth: 'calc(100vw / var(--ts) - 24px)',
          maxHeight: '500px',
          borderRadius: '16px',
          background: 'var(--card)',
          border: '1px solid var(--border)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Header with mascot */}
          <div style={{
            padding: '8px 14px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--subtle-bg)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{
                width: '48px', height: '48px', borderRadius: '50%',
                background: 'var(--input-bg)', border: '1.5px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
              }}>
                <MascotSvg thinking={sending} size={42} />
              </div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-body)' }}>
                  FleetSuite AI
                </div>
                <div style={{ fontSize: '10px', color: sending ? '#60a5fa' : 'var(--text-label)' }}>
                  {sending ? 'Thinking...' : 'Ask anything or tell me to do something'}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              {messages.length > 0 && (
                <button
                  onClick={clearChat}
                  style={{
                    background: 'none', border: 'none', color: 'var(--text-label)',
                    fontSize: '10px', cursor: 'pointer', fontWeight: 600,
                    padding: '4px 8px', borderRadius: '4px',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-label)')}
                >
                  New Chat
                </button>
              )}
              <button
                onClick={() => setIsFullScreen(v => !v)}
                title={isFullScreen ? 'Exit full screen' : 'Expand to full screen'}
                aria-label={isFullScreen ? 'Exit full screen' : 'Expand to full screen'}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-label)',
                  fontSize: '14px', cursor: 'pointer', lineHeight: 1,
                  padding: '4px 6px', borderRadius: '4px',
                }}
              >
                {isFullScreen ? '⤢' : '⤡'}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-label)',
                  fontSize: '18px', cursor: 'pointer', lineHeight: 1, padding: '0 4px',
                }}
              >
                ×
              </button>
            </div>
          </div>

          {/* Messages */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            minHeight: '200px',
            // In full-screen mode let the messages area flex to fill all
            // available vertical space; only cap in the compact view.
            maxHeight: isFullScreen ? undefined : '360px',
          }}>
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', padding: '16px 12px' }}>
                <div style={{ marginBottom: '12px' }}>
                  <MascotSvg size={80} />
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-label)', lineHeight: '1.5' }}>
                  {isAdmin
                    ? 'Ask about data, graphics jobs, customers, or tell me to do something'
                    : isInstaller
                    ? 'Ask about vehicle specs, install techniques, or your assigned vehicles'
                    : isGraphicsProduction
                    ? 'Ask about graphics jobs, production status, or schedules'
                    : 'Ask about customers, estimates, or graphics status'}
                </div>
                <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {(isAdmin ? [
                    'How many graphics jobs are in printing right now?',
                    'Who are our top 5 customers this year?',
                    'Create a graphics job for 10 unit number decals for Masterack',
                    'What open invoices does Enterprise have?',
                  ] : isInstaller ? [
                    'What vehicles are assigned to me?',
                    'What are the wrap dimensions for a 2024 Ford Transit?',
                    'How do I install graphics on a curved surface?',
                    'What vehicles are in the shop right now?',
                  ] : isGraphicsProduction ? [
                    'What jobs are behind schedule?',
                    'How many jobs are in each status right now?',
                    'Move all outgassing jobs to cutting',
                    'What graphics jobs are due this week?',
                  ] : [
                    'What open invoices does Enterprise have?',
                    'Who are our top 5 customers this year?',
                    'What graphics jobs are ready to ship?',
                  ]).map((suggestion, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setInput(suggestion);
                        setTimeout(() => inputRef.current?.focus(), 50);
                      }}
                      style={{
                        padding: '6px 10px', borderRadius: '8px', fontSize: '11px',
                        background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)',
                        color: '#60a5fa', cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  display: 'flex',
                  gap: '6px',
                  alignItems: 'flex-end',
                  flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                }}
              >
                {msg.role === 'assistant' && (
                  <div style={{ flexShrink: 0, width: '22px', height: '22px', marginBottom: '2px' }}>
                    <MascotSvg thinking={msg.loading} size={22} />
                  </div>
                )}
                <div style={{
                  padding: '8px 12px',
                  borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                  background: msg.role === 'user' ? '#3b82f6' : 'var(--subtle-bg)',
                  color: msg.role === 'user' ? '#fff' : 'var(--text-body)',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  wordBreak: 'break-word',
                }}>
                  {msg.loading ? (
                    <div style={{ display: 'flex', gap: '4px', padding: '4px 0', color: '#60a5fa' }}>
                      <span style={{ animation: 'pulse 1s infinite', animationDelay: '0s' }}>●</span>
                      <span style={{ animation: 'pulse 1s infinite', animationDelay: '0.2s' }}>●</span>
                      <span style={{ animation: 'pulse 1s infinite', animationDelay: '0.4s' }}>●</span>
                      <style>{`@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }`}</style>
                    </div>
                  ) : msg.role === 'assistant' ? (
                    <MessageBody text={msg.content} />
                  ) : (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{
            padding: '10px 12px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: '8px',
          }}>
            <input
              ref={inputRef}
              type="text"
              placeholder="Ask a question..."
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending}
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                background: 'var(--input-bg)',
                color: 'var(--text-body)',
                fontSize: '12px',
                outline: 'none',
              }}
            />
            <button
              onClick={sendMessage}
              disabled={sending || !input.trim()}
              style={{
                padding: '8px 14px',
                borderRadius: '8px',
                border: 'none',
                background: sending || !input.trim() ? 'var(--border)' : '#3b82f6',
                color: '#fff',
                fontSize: '12px',
                fontWeight: 700,
                cursor: sending || !input.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              ↑
            </button>
          </div>
        </div>
      )}
    </>
  );
}
