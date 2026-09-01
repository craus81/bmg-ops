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
 *   - Attachments: pick from the flow's available files — plus, where the
 *     flow allows it, files added straight from the sender's device — with
 *     a size cap
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
  /** Uploaded here rather than owned by the record — offer a remove button
   *  (wired to onRemoveAttachment) so a wrong file isn't stuck forever. */
  removable?: boolean;
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
  /**
   * Add a file from the sender's device. The owner stores it (and adds it
   * to `attachments`); returning its id checks it on for this send. Omit to
   * offer only the flow's existing files.
   */
  onUploadAttachment?: (file: File) => Promise<{ id?: string; error?: string }>;
  /** File types the picker offers (input accept attribute). */
  uploadAccept?: string;
  /** One-line explanation under the upload button. */
  uploadHint?: string;
  /** Delete an attachment marked `removable`. */
  onRemoveAttachment?: (id: string) => Promise<{ ok: boolean }>;
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
  onUploadAttachment,
  uploadAccept,
  uploadHint,
  onRemoveAttachment,
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

  const [toInput, setToInputState] = useState(initialTo || '');
  // A preview can prefill To *while* a click on Send is already being
  // handled, so the send path reads recipients from this ref — the click
  // handler's closure still holds the pre-prefill value.
  const toInputRef = useRef(toInput);
  const setToInput = (value: string) => { toInputRef.current = value; setToInputState(value); };
  const toTouched = useRef(!!initialTo);
  const [bccSelf, setBccSelf] = useState(loadBccSelfPref);
  const [message, setMessage] = useState('');
  const [attachmentIds, setAttachmentIds] = useState<string[]>(initialAttachmentIds || []);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<EmailComposePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const emails = parseEmailList(toInput);
  const badEntries = invalidEntries(toInput);

  const currentFields = (): EmailComposeFields => ({
    emails: parseEmailList(toInputRef.current),
    bccSelf,
    message: message.trim(),
    attachmentIds,
  });

  const attachmentById = new Map((attachments || []).map(a => [a.id, a]));
  const selectedBytes = attachmentIds.reduce(
    (sum, id) => sum + (attachmentById.get(id)?.sizeBytes || 0), 0,
  );

  // Fields the on-screen preview was built from, and the fetch still in
  // flight — both let Send stay instant instead of racing the preview.
  const previewSig = useRef<string | null>(null);
  const previewInFlight = useRef<Promise<void> | null>(null);
  const fieldsSig = (f: EmailComposeFields) =>
    JSON.stringify([f.emails, f.bccSelf, f.message, f.attachmentIds]);

  const refreshPreview = (fields?: EmailComposeFields): Promise<void> => {
    if (!fetchPreview) return Promise.resolve();
    const used = fields || currentFields();
    const run = (async () => {
      setPreviewLoading(true);
      try {
        const res = await fetchPreview(used);
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
      // Recorded with recipients as they now stand: a server prefill is part
      // of what this preview reflects, not an edit still waiting on one.
      previewSig.current = fieldsSig({ ...used, emails: parseEmailList(toInputRef.current) });
      setPreviewLoading(false);
    })();
    previewInFlight.current = run;
    return run;
  };

  // Blur hook. Leaving a field on the way to Send is the common case and
  // usually changed nothing, so don't spend a round trip on it.
  const refreshPreviewIfChanged = () => {
    const fields = currentFields();
    if (previewSig.current !== null && fieldsSig(fields) === previewSig.current) return;
    refreshPreview(fields);
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

  // Files added from the sender's device. The owner stores the file and
  // puts it in `attachments`; the returned id is what checks it on for this
  // send. Uploading is refused rather than silently left unchecked when the
  // file wouldn't fit the budget — an attachment nobody can send is worse
  // than a clear "make room first".
  const handleUploadFiles = async (files: File[]) => {
    if (!onUploadAttachment) return;
    let running = selectedBytes;
    const added: string[] = [];
    for (const file of files) {
      if (running + file.size > maxAttachmentBytes) {
        await dialog.alert(
          `"${file.name}" (${formatBytes(file.size)}) would push the attachments over ${formatBytes(maxAttachmentBytes)} — most inboxes reject emails that large. Uncheck something first, or send it another way.`,
        );
        break;
      }
      setUploadingName(file.name);
      try {
        const res = await onUploadAttachment(file);
        if (res.error || !res.id) {
          await dialog.alert(`Could not attach "${file.name}": ${res.error || 'unknown error'}`);
          break;
        }
        added.push(res.id);
        running += file.size;
      } finally {
        setUploadingName(null);
      }
    }
    if (added.length > 0) {
      const next = [...attachmentIds, ...added];
      setAttachmentIds(next);
      // The email body lists what's attached, so the preview follows.
      refreshPreview({ ...currentFields(), attachmentIds: next });
    }
  };

  const handleRemoveAttachment = async (id: string) => {
    if (!onRemoveAttachment || removingId) return;
    setRemovingId(id);
    try {
      const res = await onRemoveAttachment(id);
      if (!res.ok) return;
      const next = attachmentIds.filter(x => x !== id);
      setAttachmentIds(next);
      if (next.length !== attachmentIds.length) {
        refreshPreview({ ...currentFields(), attachmentIds: next });
      }
    } finally {
      setRemovingId(null);
    }
  };

  const handleSend = async () => {
    // Ref, not state: two fast clicks both run before a setSending re-render.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      // The one thing a send needs from the preview is the server-resolved
      // recipient for an untouched To field — so that's the only case that
      // waits on an in-flight preview.
      if (!toTouched.current && previewInFlight.current) await previewInFlight.current;
      const fields = currentFields();
      const bad = invalidEntries(toInputRef.current);
      if (bad.length > 0) {
        await dialog.alert(`These aren't valid email addresses: ${bad.join(', ')}`);
        return;
      }
      if (fields.emails.length === 0 && !allowSendWithoutTo) {
        await dialog.alert('Enter at least one recipient email address.');
        return;
      }
      const result = await onSend(fields);
      if (result.ok) onClose();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
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
            onBlur={refreshPreviewIfChanged}
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
            onBlur={refreshPreviewIfChanged}
            rows={3}
            placeholder={messagePlaceholder || 'Optional note to the recipient…'}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </div>

        {(attachments || onUploadAttachment) && (
          <div>
            <div style={labelStyle}>
              Attachments — {attachmentIds.length} selected
              {attachmentIds.length > 0 && ` (${formatBytes(selectedBytes)} of ${formatBytes(maxAttachmentBytes)} max)`}
            </div>
            {(attachments || []).length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {onUploadAttachment ? 'Nothing attached yet — add a picture or spec sheet below.' : 'No files available to attach.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '140px', overflowY: 'auto' }}>
                {(attachments || []).map(a => {
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
                      {a.removable && onRemoveAttachment && (
                        <button
                          type="button"
                          // Inside a <label>: without preventDefault the click
                          // also toggles the checkbox it wraps.
                          onClick={e => { e.preventDefault(); e.stopPropagation(); handleRemoveAttachment(a.id); }}
                          disabled={removingId === a.id}
                          title="Remove this file"
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer', padding: '0 2px', flexShrink: 0, opacity: removingId === a.id ? 0.4 : 1 }}
                        >✕</button>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
            {onUploadAttachment && (
              <div style={{ marginTop: '6px' }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={uploadAccept}
                  style={{ display: 'none' }}
                  onChange={e => {
                    const picked = Array.from(e.target.files || []);
                    // Reset first: picking the same file twice in a row fires
                    // no change event otherwise.
                    e.target.value = '';
                    handleUploadFiles(picked);
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!!uploadingName}
                  style={{ padding: '6px 10px', borderRadius: '8px', border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 700, fontSize: '11px', cursor: uploadingName ? 'default' : 'pointer', opacity: uploadingName ? 0.6 : 1 }}
                >
                  {uploadingName ? `Uploading ${uploadingName}…` : '＋ Add a picture or file'}
                </button>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  {uploadHint || `Up to ${formatBytes(maxAttachmentBytes)} of attachments per email.`}
                </div>
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
          {/* Send is never disabled by previewLoading: blurring a field on
              the way here starts a preview, and a button that turns disabled
              between mousedown and mouseup never receives the click — that's
              what made Send need a second press. */}
          <button
            onClick={handleSend}
            disabled={sending}
            style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', background: '#22c55e', color: '#fff', fontWeight: 800, fontSize: '12px', cursor: 'pointer', opacity: sending ? 0.6 : 1 }}
          >
            {sending ? 'Sending…' : sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
