'use client';

import { setInstallerPreview, type InstallerPreview } from '@/lib/installer-preview';

/**
 * Sticky notice shown on installer-facing pages while an admin is previewing
 * the portal as a specific installer. Exiting clears the preview and reloads
 * so every page drops back to the admin's own scope.
 */
export default function InstallerPreviewBanner({ preview }: { preview: InstallerPreview | null }) {
  if (!preview) return null;
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
      padding: '10px 14px', borderRadius: '10px', marginBottom: '14px',
      background: 'color-mix(in srgb, #a78bfa 12%, var(--card))',
      border: '1px solid #a78bfa',
    }}>
      <div>
        <div style={{ fontSize: '12px', fontWeight: 800, color: '#a78bfa' }}>ADMIN PREVIEW</div>
        <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600 }}>
          Viewing the portal as <strong>{preview.name}</strong> — actions you take still happen as you.
        </div>
      </div>
      <button
        onClick={() => { setInstallerPreview(null); window.location.href = '/admin/cni'; }}
        style={{
          padding: '7px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, flexShrink: 0,
          background: 'var(--card)', color: '#a78bfa', border: '1px solid #a78bfa', cursor: 'pointer',
        }}
      >
        Exit Preview
      </button>
    </div>
  );
}
