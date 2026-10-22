import { describe, it, expect } from 'vitest';
import { pickCustomerFolder, estimateFileDropboxPath, dropboxPathPart } from './estimate-file-dropbox';
import { dropboxApiArg, dropboxUploadErrorText } from './dropbox';

describe('estimate files into Dropbox', () => {
  it('goes under the client folder, Estimates, then the estimate number', () => {
    expect(estimateFileDropboxPath({ path_lower: '/office/clients/acme plumbing' }, 'EST-2610-014', 'Van 1 driver side.jpg'))
      .toBe('/office/clients/acme plumbing/Estimates/EST-2610-014/Van 1 driver side.jpg');
  });

  it('cleans path parts Dropbox would refuse', () => {
    expect(dropboxPathPart('a/b:c?.')).toBe('a b c');
    expect(dropboxPathPart('   ')).toBe('file');
  });

  it("picks the folder named like the customer, else the biggest", () => {
    const folders = [
      { id: 'atco', name: 'ATCO', path_lower: '/office/clients/atco', file_count: 900 },
      { id: 'mr', name: 'Masterack', path_lower: '/office/clients/masterack', file_count: 20 },
    ];
    expect(pickCustomerFolder(folders, ' MASTERACK ')?.id).toBe('mr');
    expect(pickCustomerFolder(folders, 'Masterack Inc')?.id).toBe('atco');
    expect(pickCustomerFolder([], 'x')).toBeNull();
  });
});

describe('Dropbox upload helpers', () => {
  it('escapes non-ASCII in the API arg header', () => {
    expect(dropboxApiArg({ path: '/Clients/Café – A' })).toBe('{"path":"/Clients/Caf\\u00e9 \\u2013 A"}');
  });

  it('says plainly when write permission is missing', () => {
    expect(dropboxUploadErrorText(401, '{"error_summary": "missing_scope/.", "error": {"required_scope": "files.content.write"}}'))
      .toMatch(/isn't allowed to save into Dropbox/);
    expect(dropboxUploadErrorText(500, 'boom')).toBe('Dropbox upload failed (500): boom');
  });
});
