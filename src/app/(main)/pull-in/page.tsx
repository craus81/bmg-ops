'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import VinScanner from '@/components/VinScanner';
import PhotoSession from '@/components/PhotoSession';
import { apiFetch } from '@/lib/api-client';
import { toJpegIfHeic } from '@/lib/heic';
import { isValidVIN } from '@/lib/vin-decoder';
import { deepLinks } from '@/lib/deep-links';
import { theme } from '@/lib/theme';

/**
 * Pull In (owner flow 2026-10-02): a shop tech pulling a vehicle into a bay
 * scans it here. A vehicle on the lot opens its pick list, which starts (or
 * joins) the job timer — moving it Received → In Progress — and asks who
 * else is working on it. A VIN that was never checked in goes to check-in.
 *
 * No readable barcode? "Photo of the VIN plate" takes a picture with the
 * same in-app camera as check-in photos and has AI read it
 * (/api/vin-plate/read), checked against the VIN check digit and the lot.
 */

interface PlateRead {
  vin: string | null;
  checkDigitOk: boolean;
  partial?: string | null;
  message?: string;
  match: null | {
    vin: string; kind: 'exact' | 'close'; differences: number;
    checkinId: string; customer: string | null; vehicle: string | null; status: string;
  };
}

/** Downscale a photo to a JPEG the reader can take (~1600 px long edge). */
async function photoForReader(file: File): Promise<string> {
  const jpeg = await toJpegIfHeic(file);
  const url = URL.createObjectURL(jpeg);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not open that photo'));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function PullInPage() {
  const router = useRouter();
  const dialog = useDialog();
  const supabase = createClient();
  const { user, isShopTech, isFieldTech, isAdmin, loading } = useAuth();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);
  const [plateRead, setPlateRead] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    if (!isShopTech && !isFieldTech && !isAdmin) router.replace('/home');
  }, [loading, user, isShopTech, isFieldTech, isAdmin, router]);

  /** A full VIN is in hand: open its pick list, or offer check-in. */
  const pullIn = async (vin: string) => {
    setError('');
    setBusy('Finding the vehicle…');
    const { data } = await supabase
      .from('fleet_checkins')
      .select('id, vin, status')
      .eq('vin', vin)
      .is('archived_at', null)
      .neq('status', 'shipped')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setBusy(null);
    if (data) {
      router.push(deepLinks.pickListPullIn(data.vin, data.id));
      return;
    }
    const checkIn = await dialog.confirm(`${vin} isn't checked in yet. Check it in now? You can pull it in right after.`, { title: 'Not checked in', confirmLabel: 'Check it in' });
    if (checkIn) router.push(`/tracking?checkin=1&pullin=1&vin=${encodeURIComponent(vin)}`);
  };

  /** Typed VIN: a full 17, or the last 6+ of a vehicle already on the lot. */
  const submitManual = async () => {
    const v = manual.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length === 17) {
      if (!isValidVIN(v)) { setError('That isn’t a valid VIN.'); return; }
      await pullIn(v);
      return;
    }
    if (v.length < 6) { setError('Enter the full VIN or at least the last 6 characters.'); return; }
    setBusy('Finding the vehicle…');
    const { data } = await supabase
      .from('fleet_checkins')
      .select('vin')
      .ilike('vin', `%${v}`)
      .is('archived_at', null)
      .neq('status', 'shipped')
      .limit(5);
    setBusy(null);
    const vins = Array.from(new Set<string>(((data || []) as { vin: string }[]).map(r => String(r.vin).toUpperCase())));
    if (vins.length === 1) await pullIn(vins[0]);
    else if (vins.length === 0) setError(`No vehicle on the lot ends in ${v}. Enter the full VIN to check it in.`);
    else setError(`${vins.length} vehicles end in ${v}. Enter more of the VIN.`);
  };

  const readPlate = async (file: File) => {
    setError('');
    setPlateRead(null);
    setBusy('Reading the VIN plate…');
    try {
      const image = await photoForReader(file);
      const res = await apiFetch('/api/vin-plate/read', { method: 'POST', body: JSON.stringify({ image, mimeType: 'image/jpeg' }) });
      const data: PlateRead & { error?: string } = await res.json().catch(() => ({}) as any);
      setBusy(null);
      if (!res.ok) { setError(data.error || 'Couldn’t read the VIN plate. Try again.'); return; }

      if (data.match?.kind === 'exact') { await pullIn(data.match.vin); return; }
      if (data.match) {
        const label = [data.match.vehicle, data.match.customer].filter(Boolean).join(' · ');
        const ok = await dialog.confirm(`The plate was hard to read. Is it this vehicle?\n\n${data.match.vin}${label ? `\n${label}` : ''}`, { confirmLabel: 'Yes, pull it in', cancelLabel: 'No' });
        if (ok) { await pullIn(data.match.vin); return; }
      }
      if (data.vin && data.checkDigitOk) {
        const ok = await dialog.confirm(`Read ${data.vin}. Is that right?`, { confirmLabel: 'Yes', cancelLabel: 'No, fix it' });
        if (ok) { await pullIn(data.vin); return; }
      }
      // Couldn't be sure: put what was read in the box to fix by hand.
      const best = data.vin || data.partial || '';
      if (best) { setManual(best); setPlateRead(best); }
      setError(data.message || (best
        ? 'Not sure about that read. Check it against the plate, fix any character, and tap Go.'
        : 'No VIN could be read in that photo. Get closer, avoid glare, and try again.'));
    } catch (err: any) {
      setBusy(null);
      setError(err?.message || 'Network error');
    }
  };

  const card: React.CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '14px', marginBottom: '14px' };

  return (
    <div style={{ maxWidth: '560px', margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Pull In a Vehicle</h1>
      <div style={{ fontSize: '13px', color: theme.textMuted, marginBottom: '14px' }}>
        Scan the VIN to start the job timer and set the vehicle In Progress.
      </div>

      <div style={card}>
        <VinScanner onScan={(v) => { if (!busy) void pullIn(v.toUpperCase()); }} theme={theme} paused={!!busy || photoOpen} scanLabel="Scan VIN barcode" />
      </div>

      <button
        onClick={() => setPhotoOpen(true)}
        disabled={!!busy}
        style={{
          width: '100%', padding: '14px', borderRadius: '12px', marginBottom: '14px',
          border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary,
          fontSize: '15px', fontWeight: 800, cursor: 'pointer',
        }}
      >📷 No barcode? Photo of the VIN plate</button>

      <div style={card}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textMuted, marginBottom: '6px' }}>
          {plateRead ? 'VIN as read — check it against the plate' : 'Or type the VIN (last 6 is enough for a vehicle on the lot)'}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            value={manual}
            onChange={e => setManual(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17))}
            onKeyDown={e => { if (e.key === 'Enter') void submitManual(); }}
            placeholder="VIN"
            autoCapitalize="characters"
            style={{
              flex: 1, padding: '12px', borderRadius: '10px', border: `1px solid ${theme.border}`,
              background: theme.inputBg, color: theme.textPrimary, fontFamily: 'monospace', fontSize: '16px', letterSpacing: '1px',
            }}
          />
          <button
            onClick={() => void submitManual()}
            disabled={!!busy || manual.length < 6}
            style={{
              padding: '12px 18px', borderRadius: '10px', border: 'none',
              background: theme.accent, color: '#fff', fontSize: '14px', fontWeight: 800, cursor: 'pointer',
            }}
          >Go</button>
        </div>
      </div>

      {busy && <div style={{ textAlign: 'center', fontSize: '14px', fontWeight: 700, color: theme.textSecondary, padding: '8px' }}>{busy}</div>}
      {error && (
        <div role="alert" style={{
          padding: '10px 12px', borderRadius: '10px', fontSize: '13px', fontWeight: 600,
          background: theme.warningBg, border: `1px solid ${theme.warning}`, color: theme.warning,
        }}>{error}</div>
      )}

      <PhotoSession
        open={photoOpen}
        title="VIN plate"
        subtitle="Fill the frame with the VIN plate, avoid glare, and take one photo"
        onShot={(file) => { setPhotoOpen(false); void readPlate(file); }}
        onClose={() => setPhotoOpen(false)}
      />
    </div>
  );
}
