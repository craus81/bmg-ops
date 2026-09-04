'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * PhotoSession — tap "Take photos" ONCE, shoot as many as you need, tap Done.
 *
 * The native `<input capture>` camera is single-shot: every picture means
 * tapping the button again, waiting for the OS camera, and coming back to
 * the page. Re-clicking the input from its own onChange (the old trick on
 * the tracking page and CompletionModal) needs a user gesture the browser
 * no longer grants, so it silently did nothing. This component keeps a live
 * viewfinder open in-app instead: a big shutter, a running count with the
 * last shot as a thumbnail, flip camera, and Done — the page underneath is
 * untouched, so Done lands you exactly where you were.
 *
 * Shots are handed out two ways so each site keeps its own upload flow:
 *   - onShot(file)  — fired per picture, the moment it's taken (sites that
 *                     upload immediately start the upload while you keep
 *                     shooting);
 *   - onDone(files) — fired once with every shot when Done is tapped (sites
 *                     that stage photos before a form submit).
 * Both are optional; pass whichever the site needs.
 *
 * When a live camera isn't available (no permission, no camera, an insecure
 * context) the overlay offers the device camera / photo library through a
 * normal file input, so nothing is ever a dead end.
 */

export interface PhotoSessionProps {
  open: boolean;
  /** Heading in the top bar, e.g. "Check-in photos". */
  title?: string;
  /** One line under the title, e.g. the vehicle. */
  subtitle?: string;
  /** index is 0 for the first shot of this session — handy for "caption applies to the first photo". */
  onShot?: (file: File, index: number) => void | Promise<void>;
  onDone?: (files: File[]) => void;
  /** Called after Done or Cancel — the host sets open=false here. */
  onClose: () => void;
  /** JPEG quality 0–1 (default 0.9). */
  quality?: number;
}

type CameraState = 'starting' | 'live' | 'unavailable';

const shotName = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `photo-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}.jpg`;
};

export default function PhotoSession({ open, title = 'Take photos', subtitle, onShot, onDone, onClose, quality = 0.9 }: PhotoSessionProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const deviceCameraRef = useRef<HTMLInputElement>(null);
  const shotsRef = useRef<File[]>([]);
  const previewsRef = useRef<string[]>([]);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const [camera, setCamera] = useState<CameraState>('starting');
  const [cameraError, setCameraError] = useState('');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [canFlip, setCanFlip] = useState(false);
  const [count, setCount] = useState(0);
  const [lastPreview, setLastPreview] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);

  const stopCamera = useCallback(() => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async (mode: 'environment' | 'user') => {
    stopCamera();
    setCamera('starting');
    setCameraError('');
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCamera('unavailable');
      setCameraError(window.isSecureContext === false ? 'The live camera needs a secure (https) connection.' : 'This browser can\'t open the camera directly.');
      return;
    }
    try {
      // Keep the constraints minimal (same as VinScanner) — Android rejects
      // exotic ones; ask for a high ideal so photos aren't viewfinder-sized.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      streamRef.current = stream;
      if (!videoRef.current) { stopCamera(); return; }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCamera('live');
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCanFlip(devices.filter(d => d.kind === 'videoinput').length > 1);
      } catch { setCanFlip(false); }
    } catch (e: any) {
      setCamera('unavailable');
      if (e?.name === 'NotAllowedError') setCameraError('Camera permission was denied. Allow camera access for this site, or use the device camera below.');
      else if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') setCameraError('No camera found on this device.');
      else setCameraError('Camera error: ' + (e?.message || 'unknown'));
    }
  }, [stopCamera]);

  // Open/close lifecycle: start the stream, lock page scroll, restore on close.
  useEffect(() => {
    if (!open) return;
    shotsRef.current = [];
    previewsRef.current = [];
    setCount(0);
    setLastPreview(null);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    startCamera(facing);
    // iOS suspends the stream when the app goes to the background; bring it
    // back when the user returns instead of showing a frozen frame.
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && open) startCamera(facing);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.body.style.overflow = prevOverflow;
      stopCamera();
      previewsRef.current.forEach(u => URL.revokeObjectURL(u));
      previewsRef.current = [];
    };
    // facing is handled by the flip handler so a flip doesn't reset the shots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const registerShot = useCallback((file: File) => {
    const index = shotsRef.current.length;
    shotsRef.current.push(file);
    const url = URL.createObjectURL(file);
    previewsRef.current.push(url);
    setLastPreview(url);
    setCount(shotsRef.current.length);
    try { navigator.vibrate?.(25); } catch { /* not supported */ }
    // Hand the shot off on a serial queue and DON'T await it here: a slow
    // upload must never lock the shutter, and one-at-a-time keeps each
    // site's "uploading…" state and caption-on-first-photo logic honest.
    if (onShot) {
      const run = () => Promise.resolve(onShot(file, index)).catch(e => console.error('[PhotoSession] onShot failed', e));
      queueRef.current = queueRef.current.then(run, run);
    }
  }, [onShot]);

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || camera !== 'live' || busy) return;
    if (video.readyState < video.HAVE_ENOUGH_DATA || !video.videoWidth) return;
    setBusy(true);
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) return;
      registerShot(new File([blob], shotName(), { type: 'image/jpeg', lastModified: Date.now() }));
    } finally {
      setBusy(false);
    }
  }, [camera, busy, quality, registerShot]);

  const flip = useCallback(() => {
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    startCamera(next);
  }, [facing, startCamera]);

  // Fallback path: the OS camera / photo library through a file input.
  const onPick = useCallback((files: FileList | null) => {
    const list = Array.from(files || []).filter(f => f.type.startsWith('image/'));
    for (const f of list) registerShot(f);
    if (fileRef.current) fileRef.current.value = '';
    if (deviceCameraRef.current) deviceCameraRef.current.value = '';
  }, [registerShot]);

  const finish = useCallback(() => {
    const shots = shotsRef.current.slice();
    stopCamera();
    if (shots.length > 0 && onDone) onDone(shots);
    onClose();
  }, [onDone, onClose, stopCamera]);

  const cancel = useCallback(() => {
    // Shots already handed to onShot are the site's; a cancel only means
    // "stop shooting" — never lose pictures that were taken. Treat it as Done.
    finish();
  }, [finish]);

  if (!open || typeof document === 'undefined') return null;

  const bar: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
    padding: '12px 14px', paddingTop: 'max(12px, env(safe-area-inset-top))',
    background: 'rgba(0,0,0,0.6)', color: '#fff',
  };
  const btn: React.CSSProperties = {
    padding: '10px 16px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.35)',
    background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: '14px', fontWeight: 800, cursor: 'pointer',
    minHeight: '44px',
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed', inset: 0, zIndex: 4000, background: '#000',
        display: 'flex', flexDirection: 'column', userSelect: 'none', WebkitUserSelect: 'none',
      }}
    >
      {/* Top bar */}
      <div style={bar}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '15px', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          {subtitle && <div style={{ fontSize: '12px', opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</div>}
        </div>
        <button type="button" onClick={finish} style={{ ...btn, background: count > 0 ? '#22c55e' : 'rgba(255,255,255,0.12)', borderColor: count > 0 ? '#22c55e' : 'rgba(255,255,255,0.35)', color: '#fff' }}>
          {count > 0 ? `Done (${count})` : 'Close'}
        </button>
      </div>

      {/* Viewfinder */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#000' }}>
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: camera === 'live' ? 'block' : 'none', transform: facing === 'user' ? 'scaleX(-1)' : undefined }}
        />
        {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: 0.7, pointerEvents: 'none' }} />}
        {camera === 'starting' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '14px', opacity: 0.8 }}>
            Starting camera…
          </div>
        )}
        {camera === 'unavailable' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '24px', textAlign: 'center', color: '#fff' }}>
            <div style={{ fontSize: '14px', maxWidth: '360px', lineHeight: 1.45 }}>{cameraError}</div>
            <button type="button" onClick={() => deviceCameraRef.current?.click()} style={{ ...btn, background: '#3b82f6', borderColor: '#3b82f6' }}>
              📷 Use the device camera
            </button>
            <button type="button" onClick={() => startCamera(facing)} style={btn}>Try again</button>
            <div style={{ fontSize: '12px', opacity: 0.7 }}>Each device-camera shot returns here — keep going, then tap Done.</div>
          </div>
        )}
        {count > 0 && lastPreview && (
          <div style={{ position: 'absolute', left: '12px', bottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
            <img src={lastPreview} alt={`Photo ${count}`} style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '10px', border: '2px solid #fff', display: 'block' }} />
            <div style={{ color: '#fff', fontSize: '13px', fontWeight: 800, textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>{count} taken</div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: '10px',
        padding: '16px 20px', paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
        background: 'rgba(0,0,0,0.75)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          <button type="button" onClick={() => fileRef.current?.click()} style={{ ...btn, fontSize: '12px', padding: '8px 12px' }} aria-label="Choose from library">
            🖼 Library
          </button>
        </div>
        <button
          type="button"
          onClick={shoot}
          disabled={camera !== 'live' || busy}
          aria-label="Take photo"
          style={{
            width: '76px', height: '76px', borderRadius: '50%',
            border: '5px solid #fff', background: camera === 'live' ? (busy ? '#cbd5e1' : '#fff') : 'rgba(255,255,255,0.3)',
            boxShadow: '0 0 0 4px rgba(0,0,0,0.6)', cursor: camera === 'live' ? 'pointer' : 'not-allowed',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {canFlip && camera === 'live' ? (
            <button type="button" onClick={flip} style={{ ...btn, fontSize: '12px', padding: '8px 12px' }} aria-label="Flip camera">🔄 Flip</button>
          ) : (
            <button type="button" onClick={cancel} style={{ ...btn, fontSize: '12px', padding: '8px 12px', opacity: 0.8 }}>Cancel</button>
          )}
        </div>
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => onPick(e.target.files)}
      />
      <input
        ref={deviceCameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        hidden
        onChange={(e) => onPick(e.target.files)}
      />
    </div>,
    document.body,
  );
}
