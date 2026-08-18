import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BILLABLE_CUSTOMERS,
  findBillableCustomer,
  matchesBillableCustomer,
  customerRequiresPo,
} from './billable-customers';

const masterack = DEFAULT_BILLABLE_CUSTOMERS[0];
const reading = DEFAULT_BILLABLE_CUSTOMERS[1];

describe('matchesBillableCustomer', () => {
  it('matches the canonical name, ignoring case and punctuation', () => {
    expect(matchesBillableCustomer(masterack, 'Masterack LLC')).toBe(true);
    expect(matchesBillableCustomer(masterack, 'masterack, llc')).toBe(true);
    expect(matchesBillableCustomer(masterack, 'MASTERACK LLC.')).toBe(true);
  });

  it('matches the short form a part tag typically carries', () => {
    expect(matchesBillableCustomer(masterack, 'Masterack')).toBe(true);
    expect(matchesBillableCustomer(reading, 'Reading Truck')).toBe(true);
    expect(matchesBillableCustomer(reading, 'Reading')).toBe(true);
  });

  it('treats "&" and "and" as the same word', () => {
    expect(matchesBillableCustomer(reading, 'Reading Equipment & Distribution')).toBe(true);
    expect(matchesBillableCustomer(reading, 'Reading Equipment and Distribution')).toBe(true);
  });

  it('does not cross-match customers or partial words', () => {
    expect(matchesBillableCustomer(masterack, 'Reading Truck')).toBe(false);
    expect(matchesBillableCustomer(reading, 'Masterack LLC')).toBe(false);
    // Word-boundary prefix only — "Master" is not "Masterack".
    expect(matchesBillableCustomer(masterack, 'Master')).toBe(false);
    expect(matchesBillableCustomer(masterack, '')).toBe(false);
    expect(matchesBillableCustomer(masterack, null)).toBe(false);
  });
});

describe('findBillableCustomer', () => {
  it('resolves free text to the list entry', () => {
    expect(findBillableCustomer(DEFAULT_BILLABLE_CUSTOMERS, 'reading truck')?.name).toBe(
      'Reading Equipment and Distribution',
    );
    expect(findBillableCustomer(DEFAULT_BILLABLE_CUSTOMERS, 'Uhaul')).toBeNull();
  });
});

describe('customerRequiresPo', () => {
  it('waives the PO gate only for explicit invoice-first customers', () => {
    expect(customerRequiresPo('Reading Equipment and Distribution', DEFAULT_BILLABLE_CUSTOMERS)).toBe(false);
    expect(customerRequiresPo('Reading Truck', DEFAULT_BILLABLE_CUSTOMERS)).toBe(false);
    expect(customerRequiresPo('Masterack LLC', DEFAULT_BILLABLE_CUSTOMERS)).toBe(true);
  });

  it('keeps the PO requirement for unknown or unstamped customers', () => {
    expect(customerRequiresPo('Some New Fleet Co', DEFAULT_BILLABLE_CUSTOMERS)).toBe(true);
    expect(customerRequiresPo(null, DEFAULT_BILLABLE_CUSTOMERS)).toBe(true);
    expect(customerRequiresPo(undefined, DEFAULT_BILLABLE_CUSTOMERS)).toBe(true);
  });
});
