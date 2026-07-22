'use client';

// Fixed upload status bar shown while files stream to R2. Pages own the
// progress state (fed by storage.upload's onProgress callback) and render
// this with it; pass null to hide. Big proof/artwork files (.psd especially)
// upload for minutes — without this the only signal was a disabled button.

export interface UploadProgress {
  fileName: string;
  fileIndex: number; // 1-based position within the batch
  fileCount: number;
  loaded: number; // bytes sent for the current file
  total: number; // current file's size in bytes
}

export default function UploadProgressBar({ progress }: { progress: UploadProgress | null }) {
  if (!progress) return null;
  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;
  const mb = (n: number) => n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  return (
    <div style={{ position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)', zIndex: 3000, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', boxShadow: '0 8px 30px rgba(0,0,0,0.35)', padding: '10px 14px', width: 'min(440px, calc(100vw - 32px))' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', fontSize: '11px', marginBottom: '6px' }}>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Uploading {progress.fileName}{progress.fileCount > 1 ? ` (${progress.fileIndex} of ${progress.fileCount})` : ''}
        </span>
        <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontWeight: 700 }}>
          {progress.total > 0 ? `${pct}% of ${mb(progress.total)}` : 'Starting…'}
        </span>
      </div>
      <div style={{ height: '6px', borderRadius: '3px', background: 'var(--subtle-bg)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: '#60a5fa', borderRadius: '3px', transition: 'width 0.15s linear' }} />
      </div>
    </div>
  );
}
