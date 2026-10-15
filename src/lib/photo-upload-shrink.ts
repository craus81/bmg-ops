/**
 * Browser-side: make a phone photo small enough to upload through an API
 * route (Vercel caps a request body at ~4.5 MB; a 12 MP iPhone JPEG can be
 * 5 MB+). HEIC becomes JPEG first (src/lib/heic.ts), then anything larger
 * than `maxEdge` on its long side is redrawn at that size as a JPEG.
 * Never throws: a photo that can't be decoded is returned as it was.
 */

import { fitWithin, toJpegIfHeic, jpegName } from './heic';

export async function shrinkPhotoForUpload(file: File, maxEdge = 2400, quality = 0.85): Promise<File> {
  const jpegOrSame = await toJpegIfHeic(file);
  try {
    const bitmap = await createImageBitmap(jpegOrSame);
    try {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
      if (width === bitmap.width && height === bitmap.height && jpegOrSame.size < 3 * 1024 * 1024) return jpegOrSame;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return jpegOrSame;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) return jpegOrSame;
      return new File([blob], jpegName(jpegOrSame.name), { type: 'image/jpeg', lastModified: file.lastModified });
    } finally {
      bitmap.close();
    }
  } catch {
    return jpegOrSame;
  }
}
