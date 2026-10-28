'use client';

/**
 * Dropbox client files linked onto a graphics job (migration 418) or an
 * estimate (migration 448), in the job's Files card or under the
 * estimate's Pictures & files: the list, an ✕ to unlink one, and the "From
 * Client Files" button that opens the picker. Links, not copies (Craig,
 * 2026-10-20), so each opens Dropbox's latest version through
 * /api/client-files/<id>.
 *
 * In split screen a Client Files file dragged across from the other side
 * and let go here is linked too (Craig, 2026-10-28; src/lib/pane-drop-targets.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useDialog } from '@/components/DialogProvider';
import { formatBytes } from '@/lib/client-files';
import { clientFileUrl, FileTile, type ClientFile } from '@/components/ClientFileRow';
import ClientFilePicker from '@/components/ClientFilePicker';
import { useClientFileDropTarget, type DroppedClientFile } from '@/lib/pane-drop-targets';

type Linked = ClientFile & { linkId: string; deleted: boolean };

/** Links picked files onto a job; used here and by the create wizard. */
export async function linkClientFilesToJob(jobId: string, fileIds: string[]): Promise<void> {
  return linkClientFiles(`/api/graphics-jobs/${jobId}/client-files`, fileIds);
}

async function linkClientFiles(endpoint: string, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const res = await apiFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ fileIds }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({} as any));
    throw new Error(json.error || `Could not add the Client Files (HTTP ${res.status})`);
  }
}

export const clientFilesButtonStyle = {
  width: '100%', padding: '8px', borderRadius: '8px',
  fontSize: '11px', fontWeight: 700, cursor: 'pointer',
  background: 'rgba(251,146,60,0.08)', border: '1px dashed rgba(251,146,60,0.45)',
  color: 'var(--orange, #fb923c)',
} as const;

interface Props {
  jobId: string;
  customerName: string | null;
  customerNetsuiteId?: string | null;
}

export default function GraphicsJobClientFiles({ jobId, ...rest }: Props) {
  return <LinkedClientFiles endpoint={`/api/graphics-jobs/${jobId}/client-files`} noun="job" {...rest} />;
}

interface LinkedProps {
  /** The record's client-files route: /api/graphics-jobs/<id>/client-files or /api/estimates/<id>/client-files. */
  endpoint: string;
  noun: 'job' | 'estimate';
  customerName: string | null;
  customerNetsuiteId?: string | null;
}

export function LinkedClientFiles({ endpoint, noun, customerName, customerNetsuiteId }: LinkedProps) {
  const dialog = useDialog();
  const [files, setFiles] = useState<Linked[]>([]);
  const [picking, setPicking] = useState(false);
  // What the last split-screen drop did: added, already here, or failed.
  const [dropNote, setDropNote] = useState<{ text: string; error: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    const res = await apiFetch(endpoint);
    const json = await res.json().catch(() => ({} as any));
    if (res.ok) { setFiles(json.files || []); loaded.current = true; }
  }, [endpoint]);

  useEffect(() => { load(); }, [load]);

  const already = useMemo(() => new Set(files.map(f => f.id)), [files]);
  const alreadyRef = useRef(already);
  alreadyRef.current = already;

  useEffect(() => {
    if (!dropNote) return;
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (dropNote.error) return; // an error stays until the next drop
    const t = window.setTimeout(() => setDropNote(null), 5000);
    return () => window.clearTimeout(t);
  }, [dropNote]);

  const onDrop = async (f: DroppedClientFile) => {
    if (loaded.current && alreadyRef.current.has(f.id)) {
      setDropNote({ text: `${f.name} is already on this ${noun}.`, error: false });
      return;
    }
    try {
      await linkClientFiles(endpoint, [f.id]);
      await load();
      setDropNote({ text: `Added ${f.name} to this ${noun}.`, error: false });
    } catch (e: any) {
      setDropNote({ text: e?.message || `Could not add ${f.name}`, error: true });
    }
  };
  useClientFileDropTarget(`Let go to add it to this ${noun}`, onDrop);

  const unlink = async (f: Linked) => {
    if (!(await dialog.confirm(`Take ${f.name} off this ${noun}? The file stays in Dropbox.`))) return;
    const res = await apiFetch(`${endpoint}?link=${f.linkId}`, { method: 'DELETE' });
    if (!res.ok) {
      const json = await res.json().catch(() => ({} as any));
      await dialog.alert(json.error || 'Could not remove it');
    }
    load();
  };

  return (
    <div ref={box}>
      {dropNote && (
        <div role="status" style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px', color: dropNote.error ? '#ef4444' : 'var(--success, #16a34a)' }}>
          {dropNote.error ? '' : '✓ '}{dropNote.text}
        </div>
      )}
      {files.length > 0 && (
        <div style={{ marginBottom: '6px' }}>
          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>From Client Files (Dropbox)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {files.map(f => (
              <div key={f.linkId} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', borderRadius: '8px', background: 'rgba(251,146,60,0.06)', border: '1px solid rgba(251,146,60,0.25)' }}>
                <FileTile file={f} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {f.deleted ? (
                    <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textDecoration: 'line-through' }}>{f.name}</span>
                  ) : (
                    <a
                      href={clientFileUrl(f)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: '#60a5fa', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >{f.name}</a>
                  )}
                  <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.deleted ? 'No longer in Dropbox' : [f.client?.name, f.folderPath].filter(Boolean).join(' › ')}
                  </div>
                </div>
                {f.size > 0 && <span style={{ fontSize: '9px', color: 'var(--text-muted)', flexShrink: 0 }}>{formatBytes(f.size)}</span>}
                <button
                  onClick={() => unlink(f)}
                  title={`Take off this ${noun} (stays in Dropbox)`}
                  style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '10px', fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}
                >✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <button type="button" onClick={() => setPicking(true)} style={{ ...clientFilesButtonStyle, marginTop: '6px' }}>
        📁 From Client Files (Dropbox)
      </button>
      {picking && (
        <ClientFilePicker
          customerName={customerName}
          customerNetsuiteId={customerNetsuiteId}
          alreadyIds={already}
          onAdd={async picked => {
            await linkClientFiles(endpoint, picked.map(f => f.id));
            await load();
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
