'use client';

import { useEffect, useState } from 'react';

// On iPhone Duo screens (html[data-sidenav], src/lib/duo-layout.ts) the More
// page says the window size the app sees, so a screenshot tells us which
// layout rule matched without a debugger. Renders nothing anywhere else.
export default function DuoScreenNote() {
  const [size, setSize] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setSize(document.documentElement.hasAttribute('data-sidenav')
      ? `${window.innerWidth} × ${window.innerHeight}` : null);
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  if (!size) return null;
  return (
    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', textAlign: 'center' }}>
      iPhone Duo layout · screen {size}
    </div>
  );
}
