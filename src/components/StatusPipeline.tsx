'use client';

import type { VehicleTrackingStatus } from '@/lib/types';
import { VEHICLE_STATUS_PIPELINE, VEHICLE_STATUS_LABELS, VEHICLE_STATUS_COLORS } from '@/lib/types';

interface StatusPipelineProps {
  currentStatus: VehicleTrackingStatus;
  onStatusSelect?: (status: VehicleTrackingStatus) => void;
  interactive?: boolean;
  compact?: boolean;
}

export default function StatusPipeline({
  currentStatus,
  onStatusSelect,
  interactive = false,
  compact = false,
}: StatusPipelineProps) {
  const currentIndex = VEHICLE_STATUS_PIPELINE.indexOf(currentStatus);

  return (
    <div style={{
      display: 'flex',
      gap: compact ? '2px' : '4px',
      flexWrap: compact ? 'wrap' : 'nowrap',
    }}>
      {VEHICLE_STATUS_PIPELINE.map((status, index) => {
        const colors = VEHICLE_STATUS_COLORS[status];
        const isCurrent = status === currentStatus;
        const isPast = index < currentIndex;
        const isStuck = status === 'stuck_parts' || status === 'stuck_graphics';

        // In non-interactive compact mode, just show dots
        if (compact && !interactive) {
          return (
            <div key={status} style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: isCurrent ? colors.text : isPast ? 'var(--text-muted)' : 'var(--border)',
              transition: 'background 0.2s',
            }} title={VEHICLE_STATUS_LABELS[status]} />
          );
        }

        return (
          <button
            key={status}
            onClick={() => interactive && onStatusSelect?.(status)}
            disabled={!interactive}
            style={{
              flex: compact ? 'none' : 1,
              padding: compact ? '4px 8px' : '8px 4px',
              borderRadius: compact ? '6px' : '8px',
              border: isCurrent ? `2px solid ${colors.text}` : `1px solid ${isPast ? 'var(--border-strong)' : 'var(--border)'}`,
              background: isCurrent ? colors.bg : isPast ? 'var(--subtle-bg)' : 'transparent',
              color: isCurrent ? colors.text : isPast ? 'var(--text-secondary)' : 'var(--text-muted)',
              fontSize: compact ? '10px' : '11px',
              fontWeight: isCurrent ? 800 : 600,
              textAlign: 'center',
              cursor: interactive ? 'pointer' : 'default',
              transition: 'all 0.15s ease',
              opacity: interactive ? 1 : (isCurrent || isPast ? 1 : 0.5),
              ...(interactive ? {
                ':hover': { background: colors.bg },
              } : {}),
            }}
          >
            {compact ? VEHICLE_STATUS_LABELS[status].split(' ')[0] : VEHICLE_STATUS_LABELS[status]}
          </button>
        );
      })}
    </div>
  );
}
