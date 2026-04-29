'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { isValidVIN } from '@/lib/vin-decoder';
import { lockOrientation } from '@/lib/orientation-lock';

interface VinScannerProps {
  /** Called when a valid 17-char VIN is scanned */
  onScan: (vin: string) => void;
  /** Theme object for styling */
  theme: Record<string, string>;
}

/**
 * VIN barcode scanner with:
 * - Native BarcodeDetector API (Chrome Android 83+) — best for Android
 * - ZXing fallback for browsers without BarcodeDetector
 * - Tap-to-focus on camera preview
 * - Torch (flashlight) toggle
 * - Continuous + single-shot autofocus attempts
 */
export default function VinScanner({ onScan, theme }: VinScannerProps) {
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [scanCount, setScanCount] = useState(0);
  const [lastScanned, setLastScanned] = useState('');
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [useNative, setUseNative] = useState(false);
  const [focusMsg, setFocusMsg] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<any>(null);
  const foundRef = useRef(false);
  const scanCountRef = useRef(0);
  const zxingReaderRef = useRef<any>(null);
  const nativeDetectorRef = useRef<any>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => { stopCamera(); };
  }, []);

  // Auto-start camera on mount
  useEffect(() => {
    startCamera();
  }, []);

  // Lock screen to portrait while the scanner is mounted so the camera
  // preview doesn't reflow mid-scan. No-op where the API isn't allowed
  // (iOS Safari, desktop without fullscreen).
  useEffect(() => {
    const unlock = lockOrientation('portrait');
    return unlock;
  }, []);

  const stopCamera = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if ((streamRef as any)?._refocusInterval) { clearInterval((streamRef as any)._refocusInterval); }
    if ((streamRef as any)?._focusKickInterval) { clearInterval((streamRef as any)._focusKickInterval); }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  }, []);

  const startCamera = async () => {
    setCameraError('');
    foundRef.current = false;
    setLastScanned('');
    setScanCount(0);
    scanCountRef.current = 0;

    try {
      // Check for native BarcodeDetector (Chrome Android 83+)
      const hasNative = typeof (window as any).BarcodeDetector !== 'undefined';
      let nativeSupported = false;
      if (hasNative) {
        try {
          const formats = await (window as any).BarcodeDetector.getSupportedFormats();
          nativeSupported = formats.some((f: string) =>
            ['code_128', 'code_39', 'code_93', 'qr_code', 'data_matrix', 'pdf417', 'itf'].includes(f)
          );
          if (nativeSupported) {
            nativeDetectorRef.current = new (window as any).BarcodeDetector({
              formats: formats.filter((f: string) =>
                ['code_128', 'code_39', 'code_93', 'qr_code', 'data_matrix', 'pdf417', 'itf'].includes(f)
              ),
            });
            setUseNative(true);
            console.log('[Scanner] Using native BarcodeDetector, formats:', formats);
          }
        } catch (e) {
          console.log('[Scanner] BarcodeDetector check failed:', e);
        }
      }

      // If no native detector, set up ZXing as fallback
      if (!nativeSupported) {
        const zxingLibrary = await import('@zxing/library');
        const formats = [
          zxingLibrary.BarcodeFormat.CODE_128, zxingLibrary.BarcodeFormat.CODE_39,
          zxingLibrary.BarcodeFormat.CODE_93, zxingLibrary.BarcodeFormat.DATA_MATRIX,
          zxingLibrary.BarcodeFormat.QR_CODE, zxingLibrary.BarcodeFormat.PDF_417,
          zxingLibrary.BarcodeFormat.ITF,
        ];
        const hints = new Map();
        hints.set(zxingLibrary.DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.set(zxingLibrary.DecodeHintType.TRY_HARDER, true);
        const reader = new zxingLibrary.MultiFormatReader();
        reader.setHints(hints);
        zxingReaderRef.current = { reader, lib: zxingLibrary };
        setUseNative(false);
        console.log('[Scanner] Using ZXing fallback');
      }

      // Get camera stream — keep constraints minimal for Android compatibility
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        }
      });
      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);

      // Set up autofocus and torch detection
      const track = stream.getVideoTracks()[0];
      if (track) {
        setupFocus(track);
        detectTorch(track);
      }

      // Start scanning loop
      const scanInterval = nativeSupported ? 300 : 200; // native is heavier per call
      intervalRef.current = setInterval(() => {
        if (nativeSupported) {
          scanFrameNative();
        } else {
          scanFrameZxing();
        }
      }, scanInterval);

    } catch (e: any) {
      if (e?.name === 'NotAllowedError') setCameraError('Camera permission denied. Please allow camera access and try again.');
      else if (e?.name === 'NotFoundError') setCameraError('No camera found on this device.');
      else setCameraError('Camera error: ' + (e?.message || 'Unknown'));
    }
  };

  // ── Focus Setup ──
  const setupFocus = (track: MediaStreamTrack) => {
    try {
      const caps = (track as any).getCapabilities?.() || {};
      const supportedModes: string[] = caps.focusMode || [];
      console.log('[Scanner] Focus modes:', supportedModes);

      if (supportedModes.includes('continuous')) {
        (track as any).applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
          .then(() => console.log('[Scanner] Continuous focus set'))
          .catch(() => {});
      } else if (supportedModes.includes('single-shot')) {
        const refocus = setInterval(async () => {
          try {
            await (track as any).applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
          } catch {}
        }, 1500);
        (streamRef as any)._refocusInterval = refocus;
        console.log('[Scanner] Periodic single-shot focus');
      }

      // ImageCapture focus kick — helps many Android devices
      if (typeof ImageCapture !== 'undefined') {
        try {
          const imgCapture = new (ImageCapture as any)(track);
          const kick = setInterval(async () => {
            try { await imgCapture.grabFrame(); } catch {}
          }, 2500);
          (streamRef as any)._focusKickInterval = kick;
        } catch {}
      }
    } catch (e) {
      console.log('[Scanner] Focus setup error:', e);
    }
  };

  // ── Torch Detection ──
  const detectTorch = (track: MediaStreamTrack) => {
    try {
      const caps = (track as any).getCapabilities?.() || {};
      if (caps.torch) {
        setTorchSupported(true);
        console.log('[Scanner] Torch supported');
      }
    } catch {}
  };

  // ── Toggle Torch ──
  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const newState = !torchOn;
    try {
      await (track as any).applyConstraints({ advanced: [{ torch: newState }] });
      setTorchOn(newState);
    } catch (e) {
      console.log('[Scanner] Torch toggle failed:', e);
    }
  };

  // ── Tap to Focus ──
  const handleTapToFocus = async (e: React.MouseEvent<HTMLDivElement>) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    try {
      const caps = (track as any).getCapabilities?.() || {};

      // Try pointsOfInterest first (modern Android Chrome)
      if (caps.pointsOfInterest) {
        await (track as any).applyConstraints({
          advanced: [{ pointsOfInterest: [{ x, y }], focusMode: 'single-shot' }]
        });
        setFocusMsg('Focusing...');
        setTimeout(() => setFocusMsg(''), 1000);
        console.log('[Scanner] Tap-to-focus at', x.toFixed(2), y.toFixed(2));
        return;
      }

      // Fallback: just trigger single-shot focus
      const modes: string[] = caps.focusMode || [];
      if (modes.includes('single-shot')) {
        await (track as any).applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
        setFocusMsg('Focusing...');
        setTimeout(() => setFocusMsg(''), 1000);
      }
    } catch (err) {
      console.log('[Scanner] Tap-to-focus error:', err);
    }
  };

  // ── Process a decoded string ──
  const processResult = (rawText: string) => {
    if (foundRef.current) return;
    const clean = rawText.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
    setLastScanned(clean);
    if (clean.length === 17 && isValidVIN(clean)) {
      foundRef.current = true;
      stopCamera();
      onScan(clean);
    }
  };

  // ── Native BarcodeDetector scan ──
  const scanFrameNative = async () => {
    if (foundRef.current || !videoRef.current || !nativeDetectorRef.current) return;
    if (videoRef.current.readyState < videoRef.current.HAVE_ENOUGH_DATA) return;
    scanCountRef.current++;
    setScanCount(scanCountRef.current);
    try {
      const barcodes = await nativeDetectorRef.current.detect(videoRef.current);
      for (const barcode of barcodes) {
        processResult(barcode.rawValue);
        if (foundRef.current) break;
      }
    } catch { /* no barcode */ }
  };

  // ── ZXing fallback scan ──
  const scanFrameZxing = () => {
    if (foundRef.current || !videoRef.current || !canvasRef.current || !zxingReaderRef.current) return;
    const video = videoRef.current;
    if (video.readyState < video.HAVE_ENOUGH_DATA) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    scanCountRef.current++;
    setScanCount(scanCountRef.current);
    try {
      const { reader, lib } = zxingReaderRef.current;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const len = imageData.data.length / 4;
      const luminances = new Uint8ClampedArray(len);
      for (let i = 0; i < len; i++) {
        luminances[i] = Math.round(
          0.299 * imageData.data[i * 4] + 0.587 * imageData.data[i * 4 + 1] + 0.114 * imageData.data[i * 4 + 2]
        );
      }
      const source = new lib.RGBLuminanceSource(luminances, canvas.width, canvas.height);
      const bitmap = new lib.BinaryBitmap(new lib.HybridBinarizer(source));
      const decoded = reader.decode(bitmap);
      processResult(decoded.getText());
    } catch { /* no barcode in frame */ }
  };

  if (cameraError) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, borderRadius: '14px' }}>
        <div style={{ color: theme.error, fontSize: '13px', marginBottom: '12px' }}>{cameraError}</div>
        <button
          onClick={() => { setCameraError(''); startCamera(); }}
          style={{ padding: '10px 20px', borderRadius: '10px', background: theme.navy, color: '#fff', fontWeight: 700, fontSize: '13px', border: 'none', cursor: 'pointer' }}
        >Retry Camera</button>
      </div>
    );
  }

  return (
    <div>
      <div
        onClick={handleTapToFocus}
        style={{ position: 'relative', borderRadius: '12px', overflow: 'hidden', background: '#000', height: '300px', marginBottom: '8px', cursor: 'pointer' }}
      >
        <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />

        {/* Scan target overlay */}
        <div style={{
          position: 'absolute', top: '50%', left: '3%', right: '3%', height: '70px', marginTop: '-35px',
          border: '3px solid rgba(238,49,32,0.7)', borderRadius: '10px', pointerEvents: 'none',
          boxShadow: '0 0 20px rgba(238,49,32,0.2)',
        }} />

        {/* Focus indicator */}
        {focusMsg && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            padding: '6px 14px', borderRadius: '20px', background: 'rgba(0,0,0,0.7)',
            color: '#fff', fontSize: '12px', fontWeight: 700, pointerEvents: 'none',
          }}>{focusMsg}</div>
        )}

        {/* Top-right badges */}
        <div style={{ position: 'absolute', top: '8px', right: '8px', display: 'flex', gap: '6px' }}>
          {/* Torch toggle */}
          {torchSupported && (
            <button
              onClick={(e) => { e.stopPropagation(); toggleTorch(); }}
              style={{
                padding: '6px 10px', borderRadius: '8px', fontSize: '14px',
                background: torchOn ? 'rgba(250,204,21,0.9)' : 'rgba(0,0,0,0.6)',
                border: 'none', cursor: 'pointer', lineHeight: 1,
              }}
            >Light</button>
          )}

          {/* Scanner engine badge */}
          <div style={{
            padding: '4px 8px', borderRadius: '6px', fontSize: '9px', fontWeight: 700,
            background: useNative ? 'rgba(34,197,94,0.8)' : 'rgba(0,0,0,0.6)',
            color: '#fff', letterSpacing: '0.5px',
          }}>
            {useNative ? 'NATIVE' : 'ZXING'}
          </div>
        </div>

        {/* Bottom info bar */}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '10px', background: 'rgba(0,0,0,0.7)' }}>
          {cameraActive ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '13px', color: '#fff', fontWeight: 700 }}>
                {torchSupported ? 'Tap screen to focus · Hold 4-8 in from barcode' : 'Tap screen to focus · Hold 4-8 in from barcode'}
              </div>
              {lastScanned ? (
                <div style={{ fontSize: '13px', color: theme.warning || '#f59e0b', marginTop: '3px', fontFamily: 'monospace', fontWeight: 800 }}>
                  FOUND: {lastScanned} ({lastScanned.length} chars)
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '3px' }}>
                  Scanning... {scanCount} frames
                </div>
              )}
            </div>
          ) : (
            <div style={{ textAlign: 'center', fontSize: '13px', color: '#9ca3af' }}>Starting camera...</div>
          )}
        </div>
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}
