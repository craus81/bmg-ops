'use client';

import { useEffect, useState } from 'react';

/** True while the open iPhone Duo screen layout is on (html[data-duo-wide],
 *  stamped by DuoLayoutWatcher), following folds and rotations. */
export function useDuoWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setWide(root.hasAttribute('data-duo-wide'));
    read();
    const obs = new MutationObserver(read);
    obs.observe(root, { attributes: true, attributeFilter: ['data-duo-wide'] });
    return () => obs.disconnect();
  }, []);
  return wide;
}
