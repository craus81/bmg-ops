import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('./email-attachments', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, fetchEmailAttachments: vi.fn() };
});

import { fetchEmailAttachments } from './email-attachments';
import { fetchEstimateAttachments } from './estimate-attachments';

function photoRaw(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const grain = ((x * 2654435761 + y * 40503) >>> 24) & 15;
      raw[i] = ((x * 255) / width + grain) & 255;
      raw[i + 1] = ((y * 255) / height + grain) & 255;
      raw[i + 2] = 128 + grain;
    }
  }
  return raw;
}

describe('fetchEstimateAttachments', () => {
  it('sends a screenshot saved as PNG out as a .jpg at email size, and leaves other files alone', async () => {
    const png = await sharp(photoRaw(2400, 1800), { raw: { width: 2400, height: 1800, channels: 3 } }).png().toBuffer();
    const pdf = Buffer.from('%PDF-1.4 spec sheet');
    vi.mocked(fetchEmailAttachments).mockResolvedValueOnce({
      ok: true,
      attachments: [
        { filename: 'Screenshot 2026-10-13 at 2.33.01_PM.png', content: png, contentType: 'image/png' },
        { filename: 'Spec sheet.pdf', content: pdf, contentType: 'application/pdf' },
      ],
    });
    const rows = [
      { id: 'a', file_name: 'Screenshot 2026-10-13 at 2.33.01_PM.png', file_size: png.byteLength, file_type: 'image/png', storage_path: 'x' },
      { id: 'b', file_name: 'Spec sheet.pdf', file_size: pdf.byteLength, file_type: 'application/pdf', storage_path: 'y' },
    ];
    const out = await fetchEstimateAttachments(rows, 20 * 1024 * 1024);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.attachments.map(a => [a.filename, a.contentType])).toEqual([
      ['Screenshot 2026-10-13 at 2.33.01_PM.jpg', 'image/jpeg'],
      ['Spec sheet.pdf', 'application/pdf'],
    ]);
    expect(out.attachments[0].content.byteLength).toBeLessThan(png.byteLength / 4);
    expect(out.attachments[1].content).toBe(pdf);
  });
});
