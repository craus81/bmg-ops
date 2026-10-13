'use client';

import { useState } from 'react';
import JSZip from 'jszip';

/**
 * "Download all" on a shared-photos page: fetches each photo through the
 * share's own route and saves one zip, named after the share's heading.
 */
export default function DownloadAllButton({ token, photoIds, zipName }: {
  token: string;
  photoIds: string[];
  zipName: string;
}) {
  const [progress, setProgress] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const run = async () => {
    setFailed(false);
    const zip = new JSZip();
    let added = 0;
    for (let i = 0; i < photoIds.length; i++) {
      setProgress(`Getting photo ${i + 1} of ${photoIds.length}…`);
      try {
        const res = await fetch(`/api/shared-photos/${encodeURIComponent(token)}/${encodeURIComponent(photoIds[i])}?format=json`);
        if (!res.ok) continue;
        const { url, fileName } = await res.json();
        const file = await fetch(url, { credentials: 'omit' });
        if (!file.ok) continue;
        zip.file(fileName, await file.blob());
        added++;
      } catch { /* skip this one; the rest still download */ }
    }
    if (added === 0) {
      setProgress(null);
      setFailed(true);
      return;
    }
    setProgress('Making the zip…');
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    setProgress(null);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      <button
        onClick={run}
        disabled={progress != null}
        style={{
          padding: '10px 16px', borderRadius: '10px', border: 'none', cursor: progress ? 'wait' : 'pointer',
          background: '#2563eb', color: '#fff', fontWeight: 800, fontSize: '14px',
        }}
      >{progress ? progress : `⬇ Download all (${photoIds.length})`}</button>
      {failed && <span style={{ fontSize: '13px', color: '#b91c1c' }}>The photos couldn&apos;t be downloaded. Try one at a time below.</span>}
    </div>
  );
}
