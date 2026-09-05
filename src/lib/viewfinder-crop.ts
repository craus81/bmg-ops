/**
 * What part of a camera frame is on screen — for a viewfinder that shows the
 * frame letterboxed (`object-fit: contain`) and then enlarged around its
 * centre by a digital zoom factor, clipped to the viewfinder box.
 *
 * The PhotoSession shutter crops the capture to exactly this region so the
 * saved photo matches the preview at every zoom level and orientation
 * (with `cover` the preview cropped in while the file kept the whole frame,
 * which read as "it zooms in when I rotate").
 *
 * All sizes are in the same unit family per argument (frame: video pixels,
 * box: CSS pixels); the result is in video pixels.
 */
export interface CropRegion { sx: number; sy: number; sw: number; sh: number }

export function visibleFrameRegion(
  frameW: number, frameH: number,
  boxW: number, boxH: number,
  zoom: number,
): CropRegion {
  if (frameW <= 0 || frameH <= 0 || boxW <= 0 || boxH <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(0, frameW), sh: Math.max(0, frameH) };
  }
  const z = Number.isFinite(zoom) && zoom > 1 ? zoom : 1;
  // contain: the frame is scaled uniformly so it fits the box, then zoomed.
  const scale = Math.min(boxW / frameW, boxH / frameH) * z;
  // The box, in frame pixels, centred on the frame — never more than the frame.
  const sw = Math.min(frameW, boxW / scale);
  const sh = Math.min(frameH, boxH / scale);
  return {
    sx: (frameW - sw) / 2,
    sy: (frameH - sh) / 2,
    sw,
    sh,
  };
}
