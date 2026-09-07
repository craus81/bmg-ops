import { describe, it, expect } from 'vitest';
import {
  checkStoragePath,
  ALLOWED_STORAGE_PREFIXES,
  INSTALLER_READ_PREFIXES,
  INSTALLER_WRITE_PREFIXES,
} from './storage-guard';

const staff = { write: false, access: 'staff' as const };
const installer = { write: false, access: 'installer' as const };
const none = { write: false, access: 'none' as const };

describe('checkStoragePath — shape defenses (every tier)', () => {
  it('rejects traversal, absolute, and control-char paths', () => {
    expect(checkStoragePath('photos', '../secrets', staff)).toBe('Invalid path');
    expect(checkStoragePath('photos', '/abs', staff)).toBe('Invalid path');
    expect(checkStoragePath('photos', 'a\\b', staff)).toBe('Invalid path');
    expect(checkStoragePath('photos', 'a\0b', staff)).toBe('Invalid path');
    expect(checkStoragePath('photos', '', staff)).toBe('Invalid path');
    expect(checkStoragePath('Bad Bucket', 'x', staff)).toBe('Invalid bucket');
  });

  it('signed-documents is denied for everyone, both operations', () => {
    expect(checkStoragePath('signed-documents', 'x.pdf', staff)).toBe('Forbidden bucket');
    expect(checkStoragePath('signed-documents', 'x.pdf', { write: true, access: 'staff' })).toBe('Forbidden bucket');
    expect(checkStoragePath('signed-documents', 'x.pdf', installer)).toBe('Forbidden bucket');
  });
});

describe('checkStoragePath — R3-22 caller tiers', () => {
  it('staff read any well-formed non-denied prefix, write only the allowlist', () => {
    expect(checkStoragePath('photos', 'vehicles/v1/a.jpg', staff)).toBeNull();
    expect(checkStoragePath('some-unknown-prefix', 'x', staff)).toBeNull(); // read ok
    expect(checkStoragePath('some-unknown-prefix', 'x', { write: true, access: 'staff' })).toBe('Forbidden bucket');
    for (const b of ALLOWED_STORAGE_PREFIXES) {
      expect(checkStoragePath(b, 'x', { write: true, access: 'staff' })).toBeNull();
    }
  });

  it('installers read only their floor prefixes', () => {
    for (const b of INSTALLER_READ_PREFIXES) {
      expect(checkStoragePath(b, 'x', installer)).toBeNull();
    }
    // The sensitive rest of the store is out of reach — notably cni-photos,
    // whose reads must stay on the record-scoped CNI routes (#765).
    expect(checkStoragePath('cni-photos', 'x', installer)).toBe('Forbidden bucket');
    expect(checkStoragePath('prospect-files', 'x', installer)).toBe('Forbidden bucket');
    expect(checkStoragePath('knowledge-files', 'x', installer)).toBe('Forbidden bucket');
    expect(checkStoragePath('upfit-files', 'x', installer)).toBe('Forbidden bucket');
  });

  it('installers write only photos / invoices / cni-docs', () => {
    for (const b of INSTALLER_WRITE_PREFIXES) {
      expect(checkStoragePath(b, 'x', { write: true, access: 'installer' })).toBeNull();
    }
    expect(checkStoragePath('graphics-proofs', 'x', { write: true, access: 'installer' })).toBe('Forbidden bucket');
    expect(checkStoragePath('vehicle-templates', 'x', { write: true, access: 'installer' })).toBe('Forbidden bucket');
  });

  it('customer-only accounts are denied everything', () => {
    expect(checkStoragePath('photos', 'x', none)).toBe('Forbidden');
    expect(checkStoragePath('vehicle-templates', 'x', none)).toBe('Forbidden');
    expect(checkStoragePath('photos', 'x', { write: true, access: 'none' })).toBe('Forbidden');
  });

  it('every installer write prefix is also an app write prefix', () => {
    for (const b of INSTALLER_WRITE_PREFIXES) {
      expect(ALLOWED_STORAGE_PREFIXES.has(b)).toBe(true);
    }
  });
});
