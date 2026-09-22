'use client';

/**
 * The "?" affordance (R6-13, audit line 431). Drop it on a page and it
 * opens the guide that page is documented in.
 *
 * It renders ONLY when three things are true: this route has a guide
 * mapped, that guide is actually in the loaded library, and the viewer is
 * staff (the help API is staff-gated). A "?" that opens an empty page is
 * worse than no "?" — it teaches people the help is useless.
 *
 * The library index is fetched once per page load and cached at module
 * scope, so ten of these on one screen make one request between them.
 */

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { guideForPath } from '@/lib/help-center';

let cache: Set<string> | null = null;
let inflight: Promise<Set<string>> | null = null;

async function loadIndex(): Promise<Set<string>> {
  if (cache) return cache;
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetch('/api/help?index=1');
        if (!res.ok) return new Set<string>();
        const body = await res.json();
        return new Set<string>((body.docs || []).map((d: any) => String(d.slug)));
      } catch {
        // No index, no button. Silence is right here: a help affordance
        // failing must never put an error in front of someone doing their job.
        return new Set<string>();
      } finally {
        inflight = null;
      }
    })();
    inflight.then(s => { cache = s; });
  }
  return inflight;
}

export default function HelpButton({ slug, label = '?', tone = 'page' }: { slug?: string; label?: string; tone?: 'page' | 'header' }) {
  const router = useRouter();
  const pathname = usePathname();
  const target = slug || guideForPath(pathname);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!target) { setAvailable(false); return; }
    loadIndex().then(slugs => { if (!cancelled) setAvailable(slugs.has(target)); });
    return () => { cancelled = true; };
  }, [target]);

  if (!target || !available) return null;

  return (
    <button
      onClick={() => router.push(`/help?doc=${encodeURIComponent(target)}`)}
      title="Open the guide for this screen"
      aria-label="Help for this screen"
      style={{
        background: 'transparent',
        // The header is a fixed dark bar whatever the theme, so it can't use
        // the theme's text/border tokens.
        border: `1px solid ${tone === 'header' ? 'rgba(255,255,255,0.25)' : 'var(--border)'}`,
        borderRadius: '50%',
        width: '24px', height: '24px', minWidth: '24px', padding: 0,
        color: tone === 'header' ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)',
        fontSize: '12px', fontWeight: 800, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
      }}
    >{label}</button>
  );
}
