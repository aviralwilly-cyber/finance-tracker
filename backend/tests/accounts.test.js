import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_TYPES,
  CAPABILITIES,
  normalizeAccountType,
  capabilitiesFor,
  hasCapability
} from '../domain/accounts.js';

describe('normalizeAccountType', () => {
  it('passes through known types', () => {
    expect(normalizeAccountType('personal')).toBe('personal');
    expect(normalizeAccountType('business')).toBe('business');
  });

  // This is the property that makes the whole feature shippable without a
  // migration: every profile written before accountType existed has the
  // field absent, and must land on personal.
  it('defaults to personal when the field is absent', () => {
    expect(normalizeAccountType(undefined)).toBe('personal');
    expect(normalizeAccountType(null)).toBe('personal');
  });

  it('defaults to personal for junk rather than throwing', () => {
    expect(normalizeAccountType('enterprise')).toBe('personal');
    expect(normalizeAccountType(42)).toBe('personal');
  });
});

describe('capabilitiesFor', () => {
  it('gives a personal account its own features', () => {
    const caps = capabilitiesFor('personal');
    expect(caps).toContain('budgets');
    expect(caps).toContain('savings');
    expect(caps).toContain('household');
  });

  it('withholds personal-only features from a business account', () => {
    const caps = capabilitiesFor('business');
    expect(caps).not.toContain('budgets');
    expect(caps).not.toContain('savings');
    expect(caps).not.toContain('household');
  });

  it('withholds business-only features from a personal account', () => {
    const caps = capabilitiesFor('personal');
    expect(caps).not.toContain('invoices');
    expect(caps).not.toContain('clients');
    expect(caps).not.toContain('tax-summary');
  });

  it('shares the features that both account types need', () => {
    for (const shared of ['transactions', 'recurring', 'import', 'receipts', 'chat', 'settings']) {
      expect(capabilitiesFor('personal')).toContain(shared);
      expect(capabilitiesFor('business')).toContain(shared);
    }
  });

  // 'overview' is reachable on both sides but computes entirely different
  // numbers. The capability says the feature exists; the policy decides what
  // it returns.
  it('exposes overview to both types', () => {
    expect(capabilitiesFor('personal')).toContain('overview');
    expect(capabilitiesFor('business')).toContain('overview');
  });

  it('returns a fresh array so a caller cannot mutate the registry', () => {
    const caps = capabilitiesFor('personal');
    caps.push('admin');
    expect(capabilitiesFor('personal')).not.toContain('admin');
  });
});

describe('hasCapability', () => {
  it('answers per account type', () => {
    expect(hasCapability('business', 'invoices')).toBe(true);
    expect(hasCapability('personal', 'invoices')).toBe(false);
  });

  it('treats an absent account type as personal', () => {
    expect(hasCapability(undefined, 'budgets')).toBe(true);
    expect(hasCapability(undefined, 'invoices')).toBe(false);
  });

  it('returns false for an unknown capability instead of throwing', () => {
    expect(hasCapability('personal', 'time-travel')).toBe(false);
  });
});

describe('registry integrity', () => {
  it('defines capabilities for every declared account type', () => {
    for (const type of ACCOUNT_TYPES) {
      expect(Array.isArray(CAPABILITIES[type])).toBe(true);
      expect(CAPABILITIES[type].length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate capabilities within a type', () => {
    for (const type of ACCOUNT_TYPES) {
      expect(new Set(CAPABILITIES[type]).size).toBe(CAPABILITIES[type].length);
    }
  });
});
