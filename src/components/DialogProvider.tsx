'use client';

import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';

interface ConfirmOptions { confirmLabel?: string; cancelLabel?: string; destructive?: boolean; title?: string }
interface AlertOptions { confirmLabel?: string; title?: string }
interface PromptOptions { confirmLabel?: string; placeholder?: string; title?: string }

interface DialogApi {
  /** Yes/no confirmation. Resolves true if the primary button is pressed. */
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  /** Single-button notice. Resolves when dismissed. */
  alert: (message: string, options?: AlertOptions) => Promise<void>;
  /** Text input. Resolves the entered string, or null if cancelled. */
  prompt: (message: string, defaultValue?: string, options?: PromptOptions) => Promise<string | null>;
}

type Request =
  | { kind: 'confirm'; message: string; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'alert'; message: string; options: AlertOptions; resolve: () => void }
  | { kind: 'prompt'; message: string; options: PromptOptions; resolve: (v: string | null) => void };

const DialogContext = createContext<DialogApi | null>(null);

/**
 * App-wide confirm / alert / prompt dialogs, rendered in-app instead of via the
 * browser's native window.confirm/alert/prompt — those hang the Capacitor
 * webview (the app loads the site remotely), freezing the whole app. This
 * renders a normal React modal and resolves a promise, so it works identically
 * in the app and on the web.
 */
export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within a DialogProvider');
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [inputValue, setInputValue] = useState('');

  const confirm = useCallback(
    (message: string, options: ConfirmOptions = {}) =>
      new Promise<boolean>((resolve) => setRequest({ kind: 'confirm', message, options, resolve })),
    [],
  );
  const alert = useCallback(
    (message: string, options: AlertOptions = {}) =>
      new Promise<void>((resolve) => setRequest({ kind: 'alert', message, options, resolve })),
    [],
  );
  const prompt = useCallback(
    (message: string, defaultValue = '', options: PromptOptions = {}) =>
      new Promise<string | null>((resolve) => { setInputValue(defaultValue); setRequest({ kind: 'prompt', message, options, resolve }); }),
    [],
  );

  const api = useMemo<DialogApi>(() => ({ confirm, alert, prompt }), [confirm, alert, prompt]);

  // Resolve the open request and close. `confirmed` is true for the primary
  // button, false for cancel / backdrop / Escape.
  const settle = (confirmed: boolean) => {
    if (request) {
      if (request.kind === 'confirm') request.resolve(confirmed);
      else if (request.kind === 'alert') request.resolve();
      else request.resolve(confirmed ? inputValue : null);
    }
    setRequest(null);
    setInputValue('');
  };

  const destructive = request?.kind === 'confirm' && request.options.destructive;
  const primaryLabel = request?.options.confirmLabel || (request?.kind === 'confirm' ? 'Confirm' : 'OK');

  return (
    <DialogContext.Provider value={api}>
      {children}
      {request && (
        <div
          onClick={() => settle(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000, padding: '20px' }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', maxWidth: '400px', width: '100%', padding: '18px', boxShadow: '0 16px 60px rgba(0,0,0,0.35)' }}>
            {request.options.title && (
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>{request.options.title}</div>
            )}
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.5, whiteSpace: 'pre-line' }}>{request.message}</div>
            {request.kind === 'prompt' && (
              <input
                autoFocus
                value={inputValue}
                placeholder={request.options.placeholder}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') settle(true); if (e.key === 'Escape') settle(false); }}
                style={{ width: '100%', marginTop: '12px', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
              />
            )}
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
              <button
                onClick={() => settle(true)}
                style={{ flex: 1, padding: '11px', borderRadius: '10px', background: destructive ? '#ef4444' : 'var(--navy)', color: '#fff', fontSize: '13px', fontWeight: 800, border: 'none', cursor: 'pointer' }}
              >{primaryLabel}</button>
              {request.kind !== 'alert' && (
                <button
                  onClick={() => settle(false)}
                  style={{ flex: 1, padding: '11px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
                >{(request.kind === 'confirm' && request.options.cancelLabel) || 'Cancel'}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}
