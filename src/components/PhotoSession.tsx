'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { visibleFrameRegion } from '@/lib/viewfinder-crop';

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
 *
 * Zoom: pinch the viewfinder or drag the slider. When the browser exposes
 * the camera's own zoom (MediaStreamTrack capabilities — Android Chrome,
 * iOS 17+ Safari) that is what moves, so the sensor does the work; anywhere
 * else the same gesture is a digital zoom — the preview is enlarged and the
 * shutter crops the capture to the very region on screen. The preview is
 * letterboxed (`object-fit: contain`) rather than cropped to fill, so what
 * you see at any zoom or orientation is exactly what the saved photo holds
 * (cover-fit cropped the preview in when the phone was rotated while the
 * file kept the whole frame — it looked like rotating zoomed the camera).
 *
 * 0.5× (ultra-wide): offered on the back camera when either the track's
 * zoom range reaches below 1× (then it is just a zoom value) or the device
 * lists an ultra-wide camera (iOS Safari: "Back Ultra Wide Camera" — then
 * 0.5× switches the stream to that lens and 1× switches back). The readout
 * multiplies the lens factor in, so the slider on the ultra-wide lens reads
 * 0.5×, 0.6×, … Phones with neither simply don't get the button.
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

/** Zoom range in effect: the camera's own (hardware) or our crop (digital). */
interface ZoomRange { min: number; max: number; step: number; hardware: boolean }

// Digital zoom ceiling — a 4× crop of a 1920-wide frame is still 480px
// wide, about the floor for a usable damage / VIN-plate photo.
const DIGITAL_ZOOM: ZoomRange = { min: 1, max: 4, step: 0.05, hardware: false };

const clampZoom = (z: number, r: ZoomRange) => Math.min(r.max, Math.max(r.min, z));

type Lens = 'default' | 'ultrawide';
/** Device label the platform gives its ultra-wide back camera (iOS: "Back Ultra Wide Camera"). */
const ULTRA_WIDE_LABEL = /ultra\s*-?\s*wide/i;
/** Field-of-view factor of the ultra-wide lens relative to the main camera, as phones label it. */
const ULTRA_WIDE_FACTOR = 0.5;
const pinchDist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

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
  const viewRef = useRef<HTMLDivElement>(null);
  // Zoom lives in refs as well as state: the shutter and the pinch handler
  // need the latest value without re-binding on every slider tick.
  const zoomRef = useRef(1);
  const zoomRangeRef = useRef<ZoomRange | null>(null);
  const pendingZoomRef = useRef<number | null>(null);
  const applyingZoomRef = useRef(false);
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  // The specific camera the stream is on (null = whatever facingMode picks),
  // so a resume-from-background reopens the same lens.
  const deviceIdRef = useRef<string | null>(null);

  const [camera, setCamera] = useState<CameraState>('starting');
  const [cameraError, setCameraError] = useState('');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [canFlip, setCanFlip] = useState(false);
  const [count, setCount] = useState(0);
  const [lastPreview, setLastPreview] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [zoomRange, setZoomRangeState] = useState<ZoomRange | null>(null);
  const [lens, setLens] = useState<Lens>('default');
  const [ultraWideId, setUltraWideId] = useState<string | null>(null);

  const setZoomRange = useCallback((r: ZoomRange | null) => { zoomRangeRef.current = r; setZoomRangeState(r); }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async (mode: 'environment' | 'user', deviceId: string | null = null) => {
    stopCamera();
    deviceIdRef.current = deviceId;
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
      // A specific lens (the 0.5× ultra-wide) is asked for by exact deviceId
      // on its own — pairing it with facingMode over-constrains some browsers.
      const size = { width: { ideal: 1920 }, height: { ideal: 1440 } };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: mode, ...size },
          audio: false,
        });
      } catch (e) {
        if (!deviceId) throw e;
        // The lens went away (or the id is stale): drop back to the default
        // camera rather than dead-ending the session.
        setLens('default');
        return startCamera(mode, null);
      }
      streamRef.current = stream;
      if (!videoRef.current) { stopCamera(); return; }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCamera('live');
      // Zoom: use the camera's own when the track advertises one, else crop.
      const track = stream.getVideoTracks()[0];
      let range: ZoomRange = DIGITAL_ZOOM;
      let current = 1;
      try {
        const caps: any = track?.getCapabilities?.() ?? {};
        const zc = caps.zoom;
        if (zc && typeof zc.min === 'number' && typeof zc.max === 'number' && zc.max > zc.min) {
          range = { min: zc.min, max: zc.max, step: typeof zc.step === 'number' && zc.step > 0 ? zc.step : 0.1, hardware: true };
          const zs = (track.getSettings?.() as any)?.zoom;
          current = typeof zs === 'number' ? zs : zc.min;
        }
      } catch { /* capabilities unsupported → digital */ }
      zoomRef.current = current;
      setZoomState(current);
      setZoomRange(range);
      try {
        // Labels are populated only once permission is granted (i.e. here).
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
        setCanFlip(inputs.length > 1);
        setUltraWideId(inputs.find(d => ULTRA_WIDE_LABEL.test(d.label))?.deviceId ?? null);
      } catch { setCanFlip(false); setUltraWideId(null); }
    } catch (e: any) {
      setCamera('unavailable');
      if (e?.name === 'NotAllowedError') setCameraError('Camera permission was denied. Allow camera access for this site, or use the device camera below.');
      else if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') setCameraError('No camera found on this device.');
      else setCameraError('Camera error: ' + (e?.message || 'unknown'));
    }
  }, [stopCamera, setZoomRange]);

  // Push a hardware zoom to the track, one applyConstraints in flight at a
  // time (a pinch fires dozens of values; only the latest matters). If the
  // camera refuses, fall back to digital so the gesture still does something.
  const applyHardwareZoom = useCallback((z: number) => {
    pendingZoomRef.current = z;
    if (applyingZoomRef.current) return;
    applyingZoomRef.current = true;
    (async () => {
      while (pendingZoomRef.current != null) {
        const next = pendingZoomRef.current;
        pendingZoomRef.current = null;
        const track = streamRef.current?.getVideoTracks()[0];
        if (!track) break;
        try {
          // `zoom` is a real constraint (Media Capture spec, Chrome + iOS 17 Safari) that lib.dom doesn't type yet.
          await track.applyConstraints({ advanced: [{ zoom: next }] } as unknown as MediaTrackConstraints);
        } catch {
          const digital = { ...DIGITAL_ZOOM };
          const dz = clampZoom(next, digital);
          zoomRef.current = dz;
          setZoomState(dz);
          setZoomRange(digital);
          pendingZoomRef.current = null;
        }
      }
      applyingZoomRef.current = false;
    })();
  }, [setZoomRange]);

  const setZoom = useCallback((value: number) => {
    const range = zoomRangeRef.current;
    if (!range) return;
    const z = clampZoom(value, range);
    zoomRef.current = z;
    setZoomState(z);
    if (range.hardware) applyHardwareZoom(z);
  }, [applyHardwareZoom]);

  // Pinch to zoom on the viewfinder (touch-action: none keeps the page from
  // pinch-zooming instead). Ratios only, so the text-size CSS zoom is moot.
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) pinchRef.current = { dist: pinchDist(e.touches), zoom: zoomRef.current };
  }, []);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const p = pinchRef.current;
    if (!p || e.touches.length !== 2) return;
    const d = pinchDist(e.touches);
    if (p.dist > 0) setZoom(p.zoom * (d / p.dist));
  }, [setZoom]);
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2) pinchRef.current = null;
  }, []);

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
      if (document.visibilityState === 'visible' && open) startCamera(facing, deviceIdRef.current);
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
      // Save exactly what the viewfinder shows. With the camera's own zoom
      // the frame already is the zoomed picture (digital factor 1); with
      // digital zoom, crop the frame to the region on screen.
      const digital = zoomRangeRef.current?.hardware ? 1 : zoomRef.current;
      const box = viewRef.current?.getBoundingClientRect();
      const region = visibleFrameRegion(video.videoWidth, video.videoHeight, box?.width ?? 0, box?.height ?? 0, digital);
      canvas.width = Math.max(1, Math.round(region.sw));
      canvas.height = Math.max(1, Math.round(region.sh));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, canvas.width, canvas.height);
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
    setLens('default');
    startCamera(next);
  }, [facing, startCamera]);

  // 0.5× / 1× lens presets (back camera only). 0.5× is a plain zoom value
  // when the track's range reaches it, else a switch to the ultra-wide lens.
  const lensFactor = lens === 'ultrawide' ? ULTRA_WIDE_FACTOR : 1;
  const zoomReachesHalf = !!zoomRange?.hardware && zoomRange.min <= ULTRA_WIDE_FACTOR;
  const showLensPresets = camera === 'live' && facing === 'environment' && (zoomReachesHalf || !!ultraWideId);
  const displayZoom = lensFactor * zoom;
  const halfActive = lens === 'ultrawide' || Math.abs(displayZoom - ULTRA_WIDE_FACTOR) < 0.05;

  const pickHalf = useCallback(() => {
    if (lens === 'default' && zoomReachesHalf) { setZoom(ULTRA_WIDE_FACTOR); return; }
    if (lens === 'default' && ultraWideId) { setLens('ultrawide'); startCamera(facing, ultraWideId); return; }
    if (lens === 'ultrawide') setZoom(1);
  }, [lens, zoomReachesHalf, ultraWideId, facing, setZoom, startCamera]);

  const pickOne = useCallback(() => {
    if (lens === 'ultrawide') { setLens('default'); startCamera(facing, null); return; }
    setZoom(1);
  }, [lens, facing, setZoom, startCamera]);

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
      <div
        ref={viewRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#000', touchAction: 'none' }}
      >
        {/* contain, not cover: the preview is the whole frame the shutter
            saves (letterboxed if the shapes differ). The digital zoom is a
            CSS scale about the centre; the shutter crops to match. */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{
            width: '100%', height: '100%', objectFit: 'contain', display: camera === 'live' ? 'block' : 'none',
            transform: (() => {
              const dz = zoomRange && !zoomRange.hardware ? zoom : 1;
              return `scale(${facing === 'user' ? -dz : dz}, ${dz})`;
            })(),
            transformOrigin: 'center center',
          }}
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
            <button type="button" onClick={() => startCamera(facing, deviceIdRef.current)} style={btn}>Try again</button>
            <div style={{ fontSize: '12px', opacity: 0.7 }}>Each device-camera shot returns here — keep going, then tap Done.</div>
          </div>
        )}
        {/* Zoom readout + slider — above the last-shot thumbnail row (56px +
            margins) so the two never overlap on a narrow phone. */}
        {camera === 'live' && zoomRange && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: '84px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', pointerEvents: 'none' }}>
            {showLensPresets && (
              <div
                onTouchStart={e => e.stopPropagation()}
                onTouchEnd={e => e.stopPropagation()}
                style={{ display: 'flex', gap: '6px', padding: '4px', borderRadius: '999px', background: 'rgba(0,0,0,0.55)', pointerEvents: 'auto' }}
              >
                {([[ULTRA_WIDE_FACTOR, halfActive, pickHalf, 'Ultra-wide 0.5×'], [1, !halfActive, pickOne, 'Main camera 1×']] as const).map(([value, active, onPick, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={onPick}
                    aria-label={label}
                    aria-pressed={active}
                    style={{
                      minWidth: '44px', minHeight: '32px', padding: '0 10px', borderRadius: '999px', border: 'none', cursor: 'pointer',
                      background: active ? '#fff' : 'transparent', color: active ? '#000' : '#fff', fontSize: '12px', fontWeight: 800,
                    }}
                  >
                    {value === 1 ? '1×' : `${value}×`}
                  </button>
                ))}
              </div>
            )}
            <div
              onTouchStart={e => e.stopPropagation()}
              onTouchMove={e => e.stopPropagation()}
              onTouchEnd={e => e.stopPropagation()}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 12px', borderRadius: '999px', background: 'rgba(0,0,0,0.55)', pointerEvents: 'auto' }}
            >
              <button
                type="button"
                onClick={() => setZoom(zoomRange.min < 1 ? 1 : zoomRange.min)}
                aria-label="Reset zoom"
                style={{ background: 'none', border: 'none', color: '#fff', fontSize: '13px', fontWeight: 800, minWidth: '44px', textAlign: 'center', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}
              >
                {displayZoom.toFixed(1)}×
              </button>
              <input
                type="range"
                min={zoomRange.min}
                max={zoomRange.max}
                step={zoomRange.step}
                value={zoom}
                onChange={e => setZoom(parseFloat(e.target.value))}
                aria-label="Zoom"
                style={{ width: '150px', accentColor: '#fff' }}
              />
            </div>
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
