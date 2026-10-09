'use client';

/**
 * An order's team chat on its own page — where every order-chat push, bell
 * row and Messages → Orders row lands. Any internal role can open it, so a
 * shop or field tech without the Estimates page can still read and answer;
 * the Open buttons only show when this person's role can open that record.
 */

import { useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import OrderTeamChat from '@/components/OrderTeamChat';
import { deepLinks } from '@/lib/deep-links';
import { canOpenMentionUrl } from '@/lib/mention-access';

export default function OrderChatPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { profile, hasFeature } = useAuth();
  const [info, setInfo] = useState<{ label: string; fleetCheckinId: string | null; title: string | null } | null>(null);

  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const estimateUrl = deepLinks.estimate(id);
  const vehicleUrl = info?.fleetCheckinId ? deepLinks.vehicle(info.fleetCheckinId) : null;

  const btn: React.CSSProperties = {
    padding: '7px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text-primary)', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
  };

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <button onClick={() => router.push(deepLinks.orderChats())} style={btn}>← Order chats</button>
        <div style={{ flex: 1, minWidth: '160px' }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>{info?.label || 'Order team chat'}</div>
          {info?.title && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{info.title}</div>}
        </div>
        {canOpenMentionUrl(estimateUrl, roles, hasFeature) && (
          <button onClick={() => router.push(estimateUrl)} style={btn}>Open order</button>
        )}
        {vehicleUrl && canOpenMentionUrl(vehicleUrl, roles, hasFeature) && (
          <button onClick={() => router.push(vehicleUrl)} style={btn}>Open vehicle</button>
        )}
      </div>
      <OrderTeamChat
        estimateId={id}
        variant="page"
        flashMessageId={searchParams.get('message')}
        onLoaded={setInfo}
      />
    </div>
  );
}
