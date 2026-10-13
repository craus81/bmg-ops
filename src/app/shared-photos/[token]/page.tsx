import type { Metadata } from 'next';
import { loadPhotoShare } from '@/lib/photo-shares';
import DownloadAllButton from './DownloadAllButton';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Photos from BMG Fleet',
  robots: { index: false, follow: false },
};

/**
 * Photos BMG staff shared with a customer from Completion Photos. No login:
 * the link's token is the credential. Fixed light styling, like the
 * approval pages, since this renders on the customer's own devices.
 */

const fmtDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
};

const pageStyle: React.CSSProperties = { minHeight: '100vh', background: '#f3f4f6', color: '#1a2b36', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' };
const wrap: React.CSSProperties = { maxWidth: '1100px', margin: '0 auto', padding: '20px 16px 48px' };

function Message({ heading, body }: { heading: string; body: string }) {
  return (
    <div style={pageStyle}>
      <div style={{ ...wrap, textAlign: 'center', paddingTop: '80px' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/bmg-logo-color.png" alt="BMG Fleet" style={{ height: '44px', marginBottom: '24px' }} />
        <div style={{ fontSize: '20px', fontWeight: 800, marginBottom: '8px' }}>{heading}</div>
        <div style={{ fontSize: '14px', color: '#6b7280' }}>{body}</div>
      </div>
    </div>
  );
}

export default async function SharedPhotosPage({ params }: { params: { token: string } }) {
  const share = await loadPhotoShare(params.token);
  if (share.status === 'expired') {
    return <Message heading="This link has expired" body="Ask your BMG Fleet contact to send the photos again." />;
  }
  if (share.status !== 'ok' || share.photos.length === 0) {
    return <Message heading="Photos not found" body="This link isn't valid. Ask your BMG Fleet contact to send it again." />;
  }

  const token = params.token;
  const heading = share.title || 'Your vehicle photos';
  const zipName = `${heading.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'BMG Fleet photos'}.zip`;
  const photoUrl = (id: string, download = false) =>
    `/api/shared-photos/${encodeURIComponent(token)}/${encodeURIComponent(id)}${download ? '?download=1' : ''}`;

  return (
    <div style={pageStyle}>
      <div style={wrap}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '18px', flexWrap: 'wrap' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/bmg-logo-color.png" alt="BMG Fleet" style={{ height: '40px' }} />
          <div style={{ flex: 1, minWidth: '200px' }}>
            <div style={{ fontSize: '22px', fontWeight: 800 }}>{heading}</div>
            <div style={{ fontSize: '13px', color: '#6b7280' }}>
              {share.photos.length} photo{share.photos.length !== 1 ? 's' : ''} from BMG Fleet · shared {fmtDate(share.createdAt)}
            </div>
          </div>
          <DownloadAllButton token={token} photoIds={share.photos.map(p => p.id)} zipName={zipName} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }}>
          {share.photos.map(p => (
            <div key={p.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px', overflow: 'hidden' }}>
              <a href={photoUrl(p.id)} target="_blank" rel="noopener noreferrer" title="Open full size" style={{ display: 'block', height: '180px', background: '#e5e7eb' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl(p.id)} alt={p.fileName} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              </a>
              <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {[p.vehicle, p.vin ? `VIN …${p.vin.slice(-6).toUpperCase()}` : null].filter(Boolean).join(' · ') || p.customerName || 'Photo'}
                  </div>
                  <div style={{ fontSize: '12px', color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {[p.jobLabel, fmtDate(p.takenAt)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <a
                  href={photoUrl(p.id, true)}
                  style={{ fontSize: '12px', fontWeight: 700, color: '#2563eb', textDecoration: 'none', whiteSpace: 'nowrap' }}
                >⬇ Download</a>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: '24px', fontSize: '12px', color: '#9ca3af', textAlign: 'center' }}>
          BMG Fleet Installations · O&apos;Fallon, MO · This link works until {fmtDate(share.expiresAt)}.
        </div>
      </div>
    </div>
  );
}
