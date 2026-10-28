import { describe, expect, it } from 'vitest';
import { UPLOAD_PIECE_BYTES, uploadPieces, uploadTargetPath } from './client-files-upload';

describe('uploadTargetPath', () => {
  it('goes into the open sub-folder of the client folder', () => {
    expect(uploadTargetPath('/office/clients/home depot', 'Chevy Express/PRINT', 'van.jpg'))
      .toBe('/office/clients/home depot/Chevy Express/PRINT/van.jpg');
    expect(uploadTargetPath('/office/clients/home depot/', '', 'van.jpg')).toBe('/office/clients/home depot/van.jpg');
  });
  it('keeps names Dropbox will take', () => {
    expect(uploadTargetPath('/office/clients/acme', '', 'proof: v2?.pdf')).toBe('/office/clients/acme/proof v2 .pdf');
  });
  it('never climbs out of the client folder', () => {
    expect(uploadTargetPath('/office/clients/acme', '../other', 'x.pdf')).toBeNull();
    expect(uploadTargetPath('/office/clients/acme', 'a/./b', 'x.pdf')).toBeNull();
  });
});

describe('uploadPieces', () => {
  it('splits a file into pieces under the request limit', () => {
    const size = Math.round(UPLOAD_PIECE_BYTES * 2.5);
    const pieces = uploadPieces(size);
    expect(pieces).toHaveLength(3);
    expect(pieces[0]).toEqual([0, UPLOAD_PIECE_BYTES]);
    expect(pieces[2][1]).toBe(size);
    expect(pieces.every(([a, b]) => b - a <= UPLOAD_PIECE_BYTES)).toBe(true);
  });
  it('still sends one empty piece for an empty file', () => {
    expect(uploadPieces(0)).toEqual([[0, 0]]);
  });
});
