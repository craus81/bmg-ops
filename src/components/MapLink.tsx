'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { isApplePlatform, mapUrl, type AddressInput } from '@/lib/map-links';

/** Apple Maps on Apple devices, Google Maps elsewhere. Starts as Google on the
 *  server render and switches after mount, so hydration stays consistent. */
function useAppleMaps(): boolean {
  const [apple, setApple] = useState(false);
  useEffect(() => {
    setApple(isApplePlatform(typeof navigator !== 'undefined' ? navigator.userAgent : ''));
  }, []);
  return apple;
}

/**
 * A stored address as a tappable map link. Renders `children` (or the
 * address itself) as plain text when the address has nothing a map could
 * find, so callers can wrap any address without checking first.
 */
export function MapLink({
  address, children, directions, style, title,
}: {
  address: AddressInput;
  children?: ReactNode;
  directions?: boolean;
  style?: CSSProperties;
  title?: string;
}) {
  const apple = useAppleMaps();
  const href = mapUrl(address, { apple, directions });
  const content = children ?? (typeof address === 'string' ? address : null);
  if (!href) return <>{content}</>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title ?? (directions ? 'Get directions' : 'Open in Maps')}
      onClick={e => e.stopPropagation()}
      style={{ color: '#60a5fa', textDecoration: 'none', ...style }}
    >
      📍 {content}
    </a>
  );
}

const btn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '6px',
  padding: '10px 14px', borderRadius: '10px',
  border: '1px solid var(--border)', background: 'var(--subtle-bg)',
  color: '#60a5fa', fontWeight: 700, fontSize: '14px', textDecoration: 'none',
};

/** "Open map" + "Directions" buttons for places someone drives to. Renders
 *  nothing when the address can't be mapped. */
export function MapButtons({ address, style }: { address: AddressInput; style?: CSSProperties }) {
  const apple = useAppleMaps();
  const view = mapUrl(address, { apple });
  const go = mapUrl(address, { apple, directions: true });
  if (!view || !go) return null;
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', ...style }}>
      <a href={view} target="_blank" rel="noopener noreferrer" style={btn}>🗺️ Open map</a>
      <a href={go} target="_blank" rel="noopener noreferrer" style={btn}>🚗 Directions</a>
    </div>
  );
}
