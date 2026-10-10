import { describe, it, expect } from 'vitest';
import { createdByText, fmtCreatedDate, poCreatedBy } from './created-by';

describe('createdByText', () => {
  it('names the FleetSuite creator with the date', () => {
    expect(createdByText({ name: 'Jane Doe', at: '2026-10-07T15:00:00Z' })).toBe('Created by Jane Doe · Oct 7, 2026');
  });

  it('uses a custom verb', () => {
    expect(createdByText({ name: 'Jane Doe', label: 'Requested by' })).toBe('Requested by Jane Doe');
  });

  it('shows nothing when no creator or source is known', () => {
    expect(createdByText({ name: null, at: '2026-10-07T15:00:00Z' })).toBeNull();
    expect(createdByText({ name: '  ' })).toBeNull();
  });

  it('labels NetSuite records with or without the employee name', () => {
    expect(createdByText({ source: 'netsuite', name: 'Sam Lee', at: '2026-10-01' })).toBe('Created in NetSuite by Sam Lee · Oct 1, 2026');
    expect(createdByText({ source: 'netsuite' })).toBe('Created in NetSuite');
  });

  it('labels QuickBooks and email imports', () => {
    expect(createdByText({ source: 'quickbooks', at: '2023-03-02' })).toBe('Imported from QuickBooks · Mar 2, 2023');
    expect(createdByText({ source: 'email' })).toBe('Imported from email');
    expect(createdByText({ source: 'email', name: 'Jane Doe', at: '2026-10-09' })).toBe('Imported from email by Jane Doe · Oct 9, 2026');
  });
});

describe('fmtCreatedDate', () => {
  it('keeps date-only values on their own day', () => {
    expect(fmtCreatedDate('2026-10-01')).toBe('Oct 1, 2026');
  });
  it('ignores junk', () => {
    expect(fmtCreatedDate('nope')).toBeNull();
    expect(fmtCreatedDate(null)).toBeNull();
  });
});

describe('poCreatedBy', () => {
  it('never shows the placeholder admin on an unattributed email import', () => {
    expect(poCreatedBy({ created_by: 'admin-1', created_source: 'email_unattributed' })).toEqual({ userId: null, source: 'email' });
  });
  it('names the importer on an attributed email import', () => {
    expect(poCreatedBy({ created_by: 'u1', created_source: 'email' })).toEqual({ userId: 'u1', source: 'email' });
  });
  it('keeps hand-made POs as before', () => {
    expect(poCreatedBy({ created_by: 'u1', created_source: null })).toEqual({ userId: 'u1', source: null });
  });
});
