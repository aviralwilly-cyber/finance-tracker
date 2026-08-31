import { describe, it, expect, beforeEach } from 'vitest';
import { createBusinessSettingsService } from '../services/businessSettingsService.js';
import { normalizeBusinessSettings, structureOptions } from '../domain/business/settings.js';
import { taxProfileOn, resolveTaxProfile } from '../domain/business/rates.js';
import { normalizeInvoice } from '../domain/business/invoices.js';

function fakeRepo(initial = {}) {
  let doc = { ...initial };
  return {
    _doc: () => doc,
    async get() {
      return { ...doc };
    },
    async save(_ctx, patch) {
      // Mirrors the real repo's merge semantics for taxProfile.
      for (const [k, v] of Object.entries(patch)) {
        doc = k === 'taxProfile'
          ? { ...doc, taxProfile: { ...(doc.taxProfile || {}), ...v } }
          : { ...doc, [k]: v };
      }
      return { ...doc };
    }
  };
}

const CTX = { uid: 'u1', accountId: 'default', accountType: 'business' };
const TODAY = '2026-08-29';

describe('normalizeBusinessSettings', () => {
  it('returns only the fields that were sent', () => {
    const patch = normalizeBusinessSettings({ businessName: '  Acme Consulting ' });
    expect(patch).toEqual({ businessName: 'Acme Consulting' });
  });

  it('rejects an empty payload rather than writing nothing', () => {
    expect(() => normalizeBusinessSettings({})).toThrow(/No recognised settings/);
  });

  it('accepts the implemented structure', () => {
    expect(normalizeBusinessSettings({ businessStructure: 'soleProp' }))
      .toEqual({ businessStructure: 'soleProp' });
  });

  // Storing 'corporation' would make every tax read throw. Refusing at the
  // boundary turns a runtime explosion into a clear 400.
  it('refuses a structure the math cannot honour yet', () => {
    expect(() => normalizeBusinessSettings({ businessStructure: 'corporation' }))
      .toThrow(/not supported yet/);
  });

  it('rejects an unknown structure', () => {
    expect(() => normalizeBusinessSettings({ businessStructure: 'partnership' }))
      .toThrow(/must be one of/);
  });

  it('rejects a reserve percentage outside 0-100', () => {
    expect(() => normalizeBusinessSettings({ taxProfile: { incomeTaxReservePercent: 150 } }))
      .toThrow(/between 0 and 100/);
    expect(() => normalizeBusinessSettings({ taxProfile: { incomeTaxReservePercent: -1 } }))
      .toThrow(/between 0 and 100/);
  });

  it('rejects a non-boolean registration flag', () => {
    expect(() => normalizeBusinessSettings({ taxProfile: { salesTaxRegistered: 'yes' } }))
      .toThrow(/must be true or false/);
  });

  it('rejects a malformed registration date', () => {
    expect(() => normalizeBusinessSettings({ taxProfile: { salesTaxRegisteredSince: '29/08/2026' } }))
      .toThrow(/YYYY-MM-DD/);
  });

  it('defaults the registration date to today when registering without one', () => {
    const patch = normalizeBusinessSettings({ taxProfile: { salesTaxRegistered: true } }, { today: TODAY });
    expect(patch.taxProfile.salesTaxRegisteredSince).toBe(TODAY);
  });

  it('respects an explicit registration date', () => {
    const patch = normalizeBusinessSettings(
      { taxProfile: { salesTaxRegistered: true, salesTaxRegisteredSince: '2026-03-01' } },
      { today: TODAY }
    );
    expect(patch.taxProfile.salesTaxRegisteredSince).toBe('2026-03-01');
  });
});

describe('structureOptions', () => {
  it('reports availability so the UI can show unavailable options honestly', () => {
    const options = structureOptions();
    expect(options.find(o => o.id === 'soleProp').available).toBe(true);
    expect(options.find(o => o.id === 'corporation').available).toBe(false);
  });
});

describe('taxProfileOn', () => {
  const registered = resolveTaxProfile({
    province: 'QC', salesTaxRegistered: true,
    salesTaxRegisteredSince: '2026-03-01'
  });

  it('is not registered before the registration date', () => {
    expect(taxProfileOn(registered, '2026-01-15').salesTaxRegistered).toBe(false);
  });

  it('is registered on and after the registration date', () => {
    expect(taxProfileOn(registered, '2026-03-01').salesTaxRegistered).toBe(true);
    expect(taxProfileOn(registered, '2026-08-01').salesTaxRegistered).toBe(true);
  });

  it('treats a missing date as always registered', () => {
    const noDate = resolveTaxProfile({ province: 'QC', salesTaxRegistered: true });
    expect(taxProfileOn(noDate, '2020-01-01').salesTaxRegistered).toBe(true);
  });
});

describe('invoice tax uses the profile as of the issue date', () => {
  const profile = resolveTaxProfile({
    province: 'QC', salesTaxRegistered: true,
    salesTaxRegisteredSince: '2026-03-01'
  });

  it('charges no tax on an invoice issued before registration', () => {
    const inv = normalizeInvoice(
      { clientName: 'Acme', subtotal: 1000, issuedDate: '2026-01-10' },
      profile
    );
    expect(inv.taxCollected.GST || 0).toBe(0);
    expect(inv.total).toBe(1000);
  });

  it('charges tax on an invoice issued after registration', () => {
    const inv = normalizeInvoice(
      { clientName: 'Acme', subtotal: 1000, issuedDate: '2026-04-10' },
      profile
    );
    expect(inv.taxCollected.GST || 0).toBe(50);
    expect(inv.total).toBe(1149.75);
  });
});

describe('businessSettingsService', () => {
  let repo;
  let service;

  beforeEach(() => {
    repo = fakeRepo();
    service = createBusinessSettingsService({ repo });
  });

  it('returns complete defaults for an unconfigured account', async () => {
    const settings = await service.get(CTX);
    expect(settings.businessStructure).toBe('soleProp');
    expect(settings.taxProfile.salesTaxRegistered).toBe(false);
    // Rates now come from the province's component list, not flat fields.
    expect(settings.taxProfile.components.map(c => c.code)).toEqual(['HST']);
    expect(settings.taxProfile.incomeTaxReservePercent).toBe(30);
  });

  it('saves and returns the updated settings', async () => {
    const saved = await service.update(
      CTX,
      { businessName: 'Acme', taxProfile: { salesTaxRegistered: true } },
      TODAY
    );
    expect(saved.businessName).toBe('Acme');
    expect(saved.taxProfile.salesTaxRegistered).toBe(true);
    expect(saved.taxProfile.salesTaxRegisteredSince).toBe(TODAY);
  });

  // The form sends one section at a time; a partial save must not wipe the
  // keys it did not include.
  it('merges a partial taxProfile update instead of replacing it', async () => {
    await service.update(CTX, { taxProfile: { salesTaxRegistered: true } }, TODAY);
    const after = await service.update(CTX, { taxProfile: { incomeTaxReservePercent: 42 } }, TODAY);
    expect(after.taxProfile.salesTaxRegistered).toBe(true);
    expect(after.taxProfile.incomeTaxReservePercent).toBe(42);
  });

  it('does not write anything when validation fails', async () => {
    await expect(service.update(CTX, { businessStructure: 'corporation' }, TODAY))
      .rejects.toThrow(/not supported yet/);
    expect(repo._doc()).toEqual({});
  });

  it('always includes structure options for the form', async () => {
    const settings = await service.get(CTX);
    expect(settings.structureOptions).toHaveLength(2);
  });
});
