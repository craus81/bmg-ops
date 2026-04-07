'use client';

import { useRouter } from 'next/navigation';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function ReportsWidget() {
  const router = useRouter();

  return (
    <WidgetShell title="Reports" icon="" loading={false} onHeaderClick={() => router.push('/reports')}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }}>
        <p style={{ fontSize: '12px', color: theme.textMuted, textAlign: 'center', margin: 0 }}>
          Export vehicle spreadsheets and reports
        </p>
        <button
          onClick={() => router.push('/reports')}
          style={{
            padding: '8px 20px',
            borderRadius: '8px',
            border: 'none',
            background: '#60a5fa',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Go to Reports
        </button>
      </div>
    </WidgetShell>
  );
}
