'use client';

/**
 * Dropbox client files linked onto a graphics job (migration 417), in the
 * job's Files card: the list, an ✕ to unlink one, and the "From Client
 * Files" button that opens the picker. Links, not copies (Craig,
 * 2026-10-20), so each opens Dropbox's latest version through
 * /api/client-files/<id>.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useDialog } from '@/components/DialogProvider';
import { formatBytes } from '@/lib/client-files';
import { clientFileUrl, FileTile, type ClientFile } from '@/components/ClientFileRow';
import ClientFilePicker from '@/components/ClientFilePicker';

type Linked = ClientFile & { linkId: string; deleted: boolean };

/** Links picked files onto a job; used here and by the create wizard. */
export async function linkClientFilesToJob(jobId: string, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const res = await apiFetch(`/api/graphics-jobs/${jobId}/client-files`, {
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

export default function GraphicsJobClientFiles({ jobId, customerName, customerNetsuiteId }: Props) {
  const dialog = useDialog();
  const [files, setFiles] = useState<Linked[]>([]);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/graphics-jobs/${jobId}/client-files`);
    const json = await res.json().catch(() => ({} as any));
    if (res.ok) setFiles(json.files || []);
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  const already = useMemo(() => new Set(files.map(f => f.id)), [files]);

  const unlink = async (f: Linked) => {
    if (!(await dialog.confirm(`Take ${f.name} off this job? The file stays in Dropbox.`))) return;
    const res = await apiFetch(`/api/graphics-jobs/${jobId}/client-files?link=${f.linkId}`, { method: 'DELETE' });
    if (!res.ok) {
      const json = await res.json().catch(() => ({} as any));
      await dialog.alert(json.error || 'Could not remove it');
    }
    load();
  };

  return (
    <>
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
                  title="Take off this job (stays in Dropbox)"
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
            await linkClientFilesToJob(jobId, picked.map(f => f.id));
            await load();
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
