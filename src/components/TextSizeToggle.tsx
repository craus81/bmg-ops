'use client';

import { useTheme } from '@/components/ThemeProvider';
import type { TextSize } from '@/lib/text-size';

// Segmented Regular / Large / XL control, styled to match the theme toggle.
// The "Aa" preview renders at each option's relative scale so users can see
// what they're picking before the whole app re-zooms.
const OPTIONS: { id: TextSize; label: string; previewPx: number }[] = [
  { id: 'regular', label: 'Regular', previewPx: 14 },
  { id: 'large', label: 'Large', previewPx: 16 },
  { id: 'xl', label: 'XL', previewPx: 18 },
];

export default function TextSizeToggle() {
  const { textSize, setTextSize } = useTheme();

  return (
    <div style={{
      display: 'flex', gap: '4px', padding: '4px',
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: '14px', boxShadow: 'var(--shadow-sm)',
    }}>
      {OPTIONS.map((opt) => (
        <button
          key={opt.id}
          onClick={() => setTextSize(opt.id)}
          aria-pressed={textSize === opt.id}
          style={{
            flex: 1, padding: '8px 6px', borderRadius: '10px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
            background: textSize === opt.id ? 'var(--tab-active-bg)' : 'transparent',
            border: textSize === opt.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
            color: textSize === opt.id ? 'var(--text-primary)' : 'var(--text-muted)',
            transition: 'all 0.15s',
          }}
        >
          <span style={{ fontSize: `${opt.previewPx}px`, fontWeight: 800, lineHeight: 1 }} aria-hidden>Aa</span>
          <span style={{ fontSize: '11px', fontWeight: 700 }}>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
