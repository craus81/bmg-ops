'use client';

/**
 * The standard customer/vendor email compose screen (docs/
 * customer-email-standard.md). Every feature that emails someone outside
 * the company opens this modal instead of inventing its own dialog, so
 * staff always get the same controls:
 *
 *   - To: editable, multiple addresses (comma/semicolon separated)
 *   - Bcc me: one click copies the send to the signed-in user's login email
 *   - Personal message: free-text block rendered into the email body
 *   - Attachments: pick from the flow's available files, with a size cap
 *   - Live preview: the exact HTML that will go out, refreshed on edit
 *
 * The modal is presentation-only — the owning screen supplies fetchPreview
 * (server renders the real email without sending) and onSend (server
 * sends), both receiving the current EmailComposeFields. Flow-specific
 * controls (e.g. the proof-file picker on graphics jobs) render through
 * the `intro` slot; bump `previewKey` when they change so the preview
 * refetches.
 */

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';

export interface EmailComposeAttachment {
  id: string;
  name: string;
  sizeBytes?: number | null;
}

export interface EmailComposeFields {
  /** Parsed, validated recipient addresses (may be empty when allowSendWithoutTo). */
  emails: string[];
  /** Bcc the signed-in sender's login email on the real send. */
  bccSelf: boolean;
  message: string;
  attachmentIds: string[];
}

export interface EmailComposePreview {
  /** Server-resolved recipients — comma-joined string or array; either
   *  prefills an untouched To field. */
  to?: string | string[] | null;
  subject?: string | null;
  html: string;
}

interface Props {
  title: string;
  /** Flow-specific controls rendered above the standard fields. */
  intro?: React.ReactNode;
  /** Comma-separated prefill; the first preview's `to` fills it when empty. */
  initialTo?: string;
  /** Files the sender can attach. Omit to hide the attachments section. */
  attachments?: EmailComposeAttachment[];
  initialAttachmentIds?: string[];
  /** Total attachment budget; checking a file past it is blocked. */
  maxAttachmentBytes?: number;
  messagePlaceholder?: string;
  sendLabel?: string;
  /**
   * Let Send proceed with no email recipients (flows with an SMS fallback).
   * `emptyToNote` explains what happens in that case.
   */
  allowSendWithoutTo?: boolean;
  emptyToNote?: string;
  /** Bump when intro-owned inputs change so the preview refetches. */
  previewKey?: string | number;
  fetchPreview?: (
    fields: EmailComposeFields,
  ) => Promise<{ preview?: EmailComposePreview; error?: string }>;
  /** Send the email. Return ok:true to close the modal; the caller owns success/failure dialogs. */
  onSend: (fields: EmailComposeFields) => Promise<{ ok: boolean }>;
  onClose: () => void;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Split a free-text recipients field into valid addresses. */
export function parseEmailList(input: string): string[] {
  return [...new Set(
    input.split(/[,;\s]+/).map(e => e.trim().toLowerCase()).filter(e => EMAIL_RE.test(e)),
  )];
}

/** Entries that are non-empty but not valid addresses (surfaced, never silently dropped). */
function invalidEntries(input: string): string[] {
  return input.split(/[,;\s]+/).map(e => e.trim()).filter(e => e && !EMAIL_RE.test(e));
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// Bcc-me is a personal habit, not a per-send decision — staff who want a
// copy of everything (e.g. to keep it findable in Gmail) shouldn't have to
// re-tick it on every compose. Remembered per device; off by default.
const BCC_SELF_KEY = 'bmg-email-bcc-self';
export function loadBccSelfPref(): boolean {
  try { return typeof window !== 'undefined' && localStorage.getItem(BCC_SELF_KEY) === '1'; } catch { return false; }
}
export function saveBccSelfPref(on: boolean): void {
  try { localStorage.setItem(BCC_SELF_KEY, on ? '1' : '0'); } catch { /* private mode — session-only */ }
}

const labelStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
  textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: '8px',
  border: '1px solid var(--border)', background: 'var(--bg)',
  color: 'var(--text-body)', fontSize: '12px', boxSizing: 'border-box',
};

export default function EmailComposeModal({
  title,
  intro,
  initialTo,
  attachments,
  initialAttachmentIds,
  maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  messagePlaceholder,
  sendLabel = 'Send',
  allowSendWithoutTo = false,
  emptyToNote,
  previewKey,
  fetchPreview,
  onSend,
  onClose,
}: Props) {
  const { user } = useAuth();
  const dialog = useDialog();

  const [toInput, setToInput] = useState(initialTo || '');
  const toTouched = useRef(!!initialTo);
  const [bccSelf, setBccSelf] = useState(loadBccSelfPref);
  const [message, setMessage] = useState('');
  const [attachmentIds, setAttachmentIds] = useState<string[]>(initialAttachmentIds || []);
  const [preview, setPreview] = useState<EmailComposePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);

  const emails = parseEmailList(toInput);
  const badEntries = invalidEntries(toInput);

  const currentFields = (): EmailComposeFields => ({
    emails,
    bccSelf,
    message: message.trim(),
    attachmentIds,
  });

  const attachmentById = new Map((attachments || []).map(a => [a.id, a]));
  const selectedBytes = attachmentIds.reduce(
    (sum, id) => sum + (attachmentById.get(id)?.sizeBytes || 0), 0,
  );

  const refreshPreview = async (fields?: EmailComposeFields) => {
    if (!fetchPreview) return;
    setPreviewLoading(true);
    try {
      const res = await fetchPreview(fields || currentFields());
      if (res.preview) {
        setPreview(res.preview);
        // First resolved recipient prefills an untouched To field, so the
        // sender sees (and can change) exactly who the server picked.
        const resolvedTo = Array.isArray(res.preview.to) ? res.preview.to.join(', ') : res.preview.to;
        if (!toTouched.current && resolvedTo) {
          setToInput(resolvedTo);
          toTouched.current = true;
        }
      } else if (res.error) {
        await dialog.alert('Preview failed: ' + res.error);
      }
    } catch {
      await dialog.alert('Network error building preview — please try again.');
    }
    setPreviewLoading(false);
  };

  // Initial preview + refetch when intro-owned inputs (previewKey) change.
  useEffect(() => {
    refreshPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on open and on explicit key bumps only
  }, [previewKey]);

  const toggleAttachment = async (id: string) => {
    let next: string[];
    if (attachmentIds.includes(id)) {
      next = attachmentIds.filter(x => x !== id);
    } else {
      const size = attachmentById.get(id)?.sizeBytes || 0;
      if (selectedBytes + size > maxAttachmentBytes) {
        await dialog.alert(
          `Adding this file would push the attachments over ${formatBytes(maxAttachmentBytes)} — most inboxes reject emails that large. Uncheck something first, or send it another way.`,
        );
        return;
      }
      next = [...attachmentIds, id];
    }
    setAttachmentIds(next);
    // The email body lists what's attached, so the preview follows the toggle.
    refreshPreview({ ...currentFields(), attachmentIds: next });
  };

  const handleSend = async () => {
    if (sending) return;
    if (badEntries.length > 0) {
      await dialog.alert(`These aren't valid email addresses: ${badEntries.join(', ')}`);
      return;
    }
    if (emails.length === 0 && !allowSendWithoutTo) {
      await dialog.alert('Enter at least one recipient email address.');
      return;
    }
    setSending(true);
    const result = await onSend(currentFields());
    setSending(false);
    if (result.ok) onClose();
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay, rgba(0,0,0,0.5))', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
      onClick={() => { if (!sending) onClose(); }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', padding: '16px',
        width: '100%', maxWidth: '760px', maxHeight: 'calc(100vh / var(--ts) - 40px)',
        display: 'flex', flexDirection: 'column', gap: '10px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.3)', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>{title}</div>
          <button
            onClick={() => { if (!sending) onClose(); }}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer', padding: 0 }}
          >✕</button>
        </div>

        {intro}

        <div>
          <div style={labelStyle}>To — separate multiple addresses with commas</div>
          <input
            type="text"
            value={toInput}
            onChange={e => { setToInput(e.target.value); toTouched.current = true; }}
            onBlur={() => refreshPreview()}
            placeholder="customer@company.com, ap@company.com"
            style={inputStyle}
          />
          {badEntries.length > 0 && (
            <div style={{ fontSize: '10px', color: '#f59e0b', marginTop: '3px' }}>
              Not valid addresses (won't be sent to): {badEntries.join(', ')}
            </div>
          )}
          {emails.length === 0 && badEntries.length === 0 && (
            <div style={{ fontSize: '10px', color: '#f59e0b', marginTop: '3px' }}>
              {emptyToNote || 'No recipients yet — add at least one email address.'}
            </div>
          )}
        </div>

        {user?.email && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', width: 'fit-content' }}>
            <input
              type="checkbox"
              checked={bccSelf}
              onChange={e => { setBccSelf(e.target.checked); saveBccSelfPref(e.target.checked); }}
              style={{ accentColor: '#3b82f6' }}
            />
            Bcc me a copy ({user.email}) — remembered on this device
          </label>
        )}

        {preview?.subject !== undefined && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            <b style={{ color: 'var(--text-secondary)' }}>Subject:</b> {preview?.subject || '…'}
          </div>
        )}

        <div>
          <div style={labelStyle}>Personal message (shown at the top of the email)</div>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            onBlur={() => refreshPreview()}
            rows={3}
            placeholder={messagePlaceholder || 'Optional note to the recipient…'}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </div>

        {attachments && (
          <div>
            <div style={labelStyle}>
              Attachments — {attachmentIds.length} selected
              {attachmentIds.length > 0 && ` (${formatBytes(selectedBytes)} of ${formatBytes(maxAttachmentBytes)} max)`}
            </div>
            {attachments.length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No files available to attach.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '140px', overflowY: 'auto' }}>
                {attachments.map(a => {
                  const checked = attachmentIds.includes(a.id);
                  return (
                    <label key={a.id} style={{
                      display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px',
                      borderRadius: '6px', cursor: 'pointer', fontSize: '11px',
                      background: checked ? 'rgba(59,130,246,0.08)' : 'var(--subtle-bg)',
                      border: '1px solid ' + (checked ? 'rgba(59,130,246,0.3)' : 'var(--border)'),
                      color: 'var(--text-secondary)',
                    }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAttachment(a.id)}
                        style={{ accentColor: '#3b82f6' }}
                      />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>{formatBytes(a.sizeBytes)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {fetchPreview && (
          <div style={{ flex: 1, minHeight: '220px', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', background: '#f3f4f6', position: 'relative' }}>
            {previewLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#6b7280', background: 'rgba(243,244,246,0.7)', zIndex: 1 }}>Updating preview…</div>
            )}
            <iframe srcDoc={preview?.html || ''} title="Email preview" sandbox="" style={{ width: '100%', height: '100%', minHeight: '220px', border: 'none', display: 'block' }} />
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => { if (!sending) onClose(); }}
            style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-body)', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}
          >
            Cancel
          </button>
          {fetchPreview && (
            <button
              onClick={() => refreshPreview()}
              disabled={previewLoading}
              style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.1)', color: '#3b82f6', fontWeight: 700, fontSize: '12px', cursor: 'pointer', opacity: previewLoading ? 0.5 : 1 }}
            >
              Refresh Preview
            </button>
          )}
          <button
            onClick={handleSend}
            disabled={sending || previewLoading}
            style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', background: '#22c55e', color: '#fff', fontWeight: 800, fontSize: '12px', cursor: 'pointer', opacity: (sending || previewLoading) ? 0.6 : 1 }}
          >
            {sending ? 'Sending…' : sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
