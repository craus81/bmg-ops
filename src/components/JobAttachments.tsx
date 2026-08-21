'use client';

import { useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { uploadJobFiles, jobFileUrl, type JobFile } from '@/lib/job-files';
import { DropZone } from '@/components/DropZone';

/**
 * Renders a CNI job's attachments (proofs / photos / docs) as download links.
 * When `editable`, admins can add or remove files; the job row's `attachments`
 * array is updated and `onChange` is called to refresh. Read-only for
 * installers — they just download what describes the job.
 */
export default function JobAttachments({
  jobId,
  attachments,
  editable = false,
  onChange,
}: {
  jobId: string;
  attachments: JobFile[];
  editable?: boolean;
  onChange?: () => void;
}) {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const files: JobFile[] = Array.isArray(attachments) ? attachments : [];

  const handleAdd = async (picked: FileList | File[] | null) => {
    if (!picked || picked.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const { uploaded, errors } = await uploadJobFiles(jobId, Array.from(picked));
      if (errors.length) setError(errors.join('; '));
      if (uploaded.length) {
        const { error: dbErr } = await supabase
          .from('cni_jobs')
          .update({ attachments: [...files, ...uploaded] })
          .eq('id', jobId);
        if (dbErr) setError(dbErr.message);
        else onChange?.();
      }
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = async (path: string) => {
    setBusy(true);
    setError('');
    try {
      const next = files.filter(f => f.path !== path);
      const { error: dbErr } = await supabase
        .from('cni_jobs')
        .update({ attachments: next })
        .eq('id', jobId);
      if (dbErr) setError(dbErr.message);
      else {
        // Best-effort storage cleanup; the row is the source of truth.
        fetch('/api/storage', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bucket: 'photos', path }),
        }).catch(() => {});
        onChange?.();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropZone onFiles={handleAdd} multiple disabled={!editable || busy}>
      {files.length === 0 ? (
        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          {editable ? 'No files yet.' : 'No files attached.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {files.map(f => (
            <div key={f.path} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
              padding: '8px 12px', borderRadius: '8px',
              background: 'var(--input-bg)', border: '1px solid var(--border)',
            }}>
              <a
                href={jobFileUrl(f.path, f.name)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '13px', fontWeight: 600, color: 'var(--orange)', textDecoration: 'none', wordBreak: 'break-all' }}
              >
                {f.name}
              </a>
              {editable && (
                <button
                  onClick={() => handleRemove(f.path)}
                  disabled={busy}
                  style={{ flexShrink: 0, fontSize: '11px', fontWeight: 700, color: 'var(--error)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {editable && (
        <div style={{ marginTop: '10px' }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={e => handleAdd(e.target.files)}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            style={{
              padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: 'var(--subtle-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)',
            }}
          >
            {busy ? 'Uploading…' : '+ Add Files'}
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--error)', fontWeight: 600 }}>{error}</div>
      )}
    </DropZone>
  );
}
