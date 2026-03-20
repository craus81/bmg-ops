'use client';

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  loading?: boolean;
}

export default function AiChat() {
  const { isAdmin } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Don't render for non-admins
  if (!isAdmin) return null;

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

    // Scroll after state update
    setTimeout(scrollToBottom, 50);

    try {
      // Build conversation history (last 10 messages for context)
      const history = [...messages, userMsg]
        .filter(m => !m.loading)
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch('/api/ai-agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
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
    } catch (err: any) {
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
      {/* Floating button */}
      {!isOpen && (
        <button
          onClick={() => {
            setIsOpen(true);
            setTimeout(() => inputRef.current?.focus(), 100);
          }}
          style={{
            position: 'fixed',
            bottom: '80px',
            right: '16px',
            width: '52px',
            height: '52px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
            border: 'none',
            color: '#fff',
            fontSize: '22px',
            cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(59,130,246,0.4)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'transform 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.08)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
        >
          AI
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
          {/* Header */}
          <div style={{
            padding: '12px 14px',
            borderBottom: '1px solid #1e2d3d',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.1))',
          }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 800, color: '#e8ecf1' }}>
                FleetSuite AI
              </div>
              <div style={{ fontSize: '10px', color: '#4a5f78' }}>Ask anything about your NetSuite data</div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {messages.length > 0 && (
                <button
                  onClick={clearChat}
                  style={{
                    background: 'none', border: 'none', color: '#4a5f78',
                    fontSize: '10px', cursor: 'pointer', fontWeight: 600,
                    padding: '4px 8px', borderRadius: '4px',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#4a5f78')}
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  background: 'none', border: 'none', color: '#4a5f78',
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
              <div style={{ textAlign: 'center', padding: '24px 12px' }}>
                <div style={{ fontSize: '28px', marginBottom: '8px' }}>🤖</div>
                <div style={{ fontSize: '12px', color: '#4a5f78', lineHeight: '1.5' }}>
                  Ask me about customers, orders, pricing, invoices...
                </div>
                <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {[
                    'How much did we charge Pundmann for the last wrap?',
                    'Who are our top 5 customers this year?',
                    'What open invoices does Enterprise have?',
                  ].map((suggestion, i) => (
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
                }}
              >
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
                    <div style={{ display: 'flex', gap: '4px', padding: '4px 0' }}>
                      <span style={{ animation: 'pulse 1.4s infinite', animationDelay: '0s' }}>●</span>
                      <span style={{ animation: 'pulse 1.4s infinite', animationDelay: '0.2s' }}>●</span>
                      <span style={{ animation: 'pulse 1.4s infinite', animationDelay: '0.4s' }}>●</span>
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
                color: '#e8ecf1',
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
