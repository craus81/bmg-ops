'use client';

import { useState, useRef } from 'react';
import { useAuth } from '@/components/AuthProvider';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  loading?: boolean;
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
  const { isAdmin, isSales, isGraphicsProduction, profile } = useAuth();
  const hasAccess = isAdmin || isSales || isGraphicsProduction;
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

    try {
      const history = [...messages, userMsg]
        .filter(m => !m.loading)
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch('/api/ai-agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, userRole: profile?.role }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setMessages(prev => [
          ...prev.filter(m => !m.loading),
          { role: 'assistant', content: data.error || 'Something went wrong. Try again.' },
        ]);
      } else {
        setMessages(prev => [
          ...prev.filter(m => !m.loading),
          { role: 'assistant', content: data.reply },
        ]);
      }
    } catch {
      setMessages(prev => [
        ...prev.filter(m => !m.loading),
        { role: 'assistant', content: 'Network error. Check your connection and try again.' },
      ]);
    }

    setSending(false);
    setTimeout(scrollToBottom, 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
  };

  return (
    <>
      {/* Floating mascot button */}
      {!isOpen && (
        <button
          onClick={() => {
            setIsOpen(true);
            setTimeout(() => inputRef.current?.focus(), 100);
          }}
          style={{
            position: 'fixed',
            bottom: '76px',
            right: '12px',
            width: '72px',
            height: '72px',
            borderRadius: '50%',
            background: '#0a1128',
            border: '2px solid #1e3a8a',
            cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(30,58,138,0.5)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
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
        </button>
      )}

      {/* Chat panel */}
      {isOpen && (
        <div style={{
          position: 'fixed',
          bottom: '80px',
          right: '12px',
          width: '340px',
          maxHeight: '500px',
          borderRadius: '16px',
          background: '#0b1219',
          border: '1px solid #1e2d3d',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Header with mascot */}
          <div style={{
            padding: '8px 14px',
            borderBottom: '1px solid #1e2d3d',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'linear-gradient(135deg, rgba(15,27,61,0.8), rgba(10,17,40,0.8))',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{
                width: '48px', height: '48px', borderRadius: '50%',
                background: '#060d1f', border: '1.5px solid #1e3a8a',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
              }}>
                <MascotSvg thinking={sending} size={42} />
              </div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 800, color: '#f5f8fc' }}>
                  FleetSuite AI
                </div>
                <div style={{ fontSize: '10px', color: sending ? '#60a5fa' : '#e8f0f8' }}>
                  {sending ? 'Thinking...' : 'Ask anything or tell me to do something'}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {messages.length > 0 && (
                <button
                  onClick={clearChat}
                  style={{
                    background: 'none', border: 'none', color: '#e8f0f8',
                    fontSize: '10px', cursor: 'pointer', fontWeight: 600,
                    padding: '4px 8px', borderRadius: '4px',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#e8f0f8')}
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  background: 'none', border: 'none', color: '#e8f0f8',
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
            maxHeight: '360px',
          }}>
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', padding: '16px 12px' }}>
                <div style={{ marginBottom: '12px' }}>
                  <MascotSvg size={80} />
                </div>
                <div style={{ fontSize: '12px', color: '#e8f0f8', lineHeight: '1.5' }}>
                  {isAdmin
                    ? 'Ask about data, graphics jobs, customers, or tell me to do something'
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
                  background: msg.role === 'user' ? '#3b82f6' : '#1a2535',
                  color: msg.role === 'user' ? '#fff' : '#c8d6e5',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {msg.loading ? (
                    <div style={{ display: 'flex', gap: '4px', padding: '4px 0', color: '#60a5fa' }}>
                      <span style={{ animation: 'pulse 1s infinite', animationDelay: '0s' }}>●</span>
                      <span style={{ animation: 'pulse 1s infinite', animationDelay: '0.2s' }}>●</span>
                      <span style={{ animation: 'pulse 1s infinite', animationDelay: '0.4s' }}>●</span>
                      <style>{`@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }`}</style>
                    </div>
                  ) : msg.content}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{
            padding: '10px 12px',
            borderTop: '1px solid #1e2d3d',
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
                border: '1px solid #1e2d3d',
                background: '#0a1018',
                color: '#f5f8fc',
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
                background: sending || !input.trim() ? '#1e2d3d' : '#3b82f6',
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
