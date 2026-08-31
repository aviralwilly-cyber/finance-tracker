import { describe, it, expect } from 'vitest';
import { extractSalesTax } from '../domain/business/salesTax.js';
import { normalizeExpenseTax, isDeductionCapped } from '../domain/business/expenses.js';
import { resolveTaxProfile } from '../domain/business/rates.js';
import { deductibleExpenseAmount, recoverableTax } from '../domain/business/index.js';

const REGISTERED = resolveTaxProfile({ province: 'QC', salesTaxRegistered: true });
const UNREGISTERED = resolveTaxProfile({ province: 'QC', salesTaxRegistered: false });
const ONTARIO = resolveTaxProfile({ province: 'ON', salesTaxRegistered: true });

describe('extractSalesTax', () => {
  it('recovers the pre-tax base from a tax-inclusive total', () => {
    const { base, components } = extractSalesTax(114.98, REGISTERED);
    expect(base).toBe(100);
    expect(components.GST).toBe(5);
    expect(components.QST).toBe(9.98);
  });

  it('extracts a single HST component in Ontario', () => {
    const { base, components } = extractSalesTax(113, ONTARIO);
    expect(base).toBe(100);
    expect(components).toEqual({ HST: 13 });
  });

  // The reason QST is reconciled by subtraction rather than computed
  // independently. A rounding gap in a remittance figure is expensive.
  it('always reconciles exactly to the original amount', () => {
    for (const amount of [4.99, 13.37, 114.98, 1234.56, 87.31, 0.99]) {
      const { base, taxTotal } = extractSalesTax(amount, REGISTERED);
      expect(base + taxTotal).toBeCloseTo(amount, 2);
    }
  });

  it('extracts nothing when not registered', () => {
    expect(extractSalesTax(114.98, UNREGISTERED)).toEqual({ base: 114.98, components: {}, taxTotal: 0 });
  });

  it('handles a zero amount without dividing by nothing useful', () => {
    expect(extractSalesTax(0, REGISTERED)).toEqual({ base: 0, components: {}, taxTotal: 0 });
  });

  // calcSalesTax and extractSalesTax must be inverses, or an invoice and an
  // expense for the same purchase would disagree.
  it('is the inverse of calcSalesTax', () => {
    const { taxTotal } = extractSalesTax(114.98, REGISTERED);
    expect(100 + taxTotal).toBeCloseTo(114.98, 2);
  });
});

describe('normalizeExpenseTax', () => {
  it('defaults to fully deductible with tax extracted for a registrant', () => {
    const result = normalizeExpenseTax(
      { amount: 114.98 }, REGISTERED, { date: '2026-08-10' }
    );
    expect(result).toEqual({
      deductiblePercent: 100, taxPaid: { GST: 5, QST: 9.98 }, salesTaxIncluded: true
    });
  });

  it('extracts nothing when the user says tax was not included', () => {
    const result = normalizeExpenseTax(
      { amount: 114.98, salesTaxIncluded: false }, REGISTERED, { date: '2026-08-10' }
    );
    expect(result.taxPaid).toEqual({});
    expect(result.salesTaxIncluded).toBe(false);
  });

  it('extracts nothing for an unregistered account', () => {
    const result = normalizeExpenseTax({ amount: 114.98 }, UNREGISTERED, { date: '2026-08-10' });
    expect(result.taxPaid).toEqual({});
  });

  it('records a partial business-use share', () => {
    const result = normalizeExpenseTax(
      { amount: 2298, deductiblePercent: 60 }, REGISTERED, { date: '2026-08-10' }
    );
    expect(result.deductiblePercent).toBe(60);
  });

  it('rejects a business-use share outside 0-100', () => {
    expect(() => normalizeExpenseTax({ amount: 100, deductiblePercent: 120 }, REGISTERED, {}))
      .toThrow(/between 0 and 100/);
  });

  // Imported statements and unusual receipts can't be derived from a total.
  it('prefers explicit amounts over extraction', () => {
    const result = normalizeExpenseTax(
      { amount: 114.98, taxPaid: { GST: 4, QST: 8 } }, REGISTERED, { date: '2026-08-10' }
    );
    expect(result.taxPaid).toEqual({ GST: 4, QST: 8 });
  });

  it('rejects tax larger than the transaction itself', () => {
    expect(() => normalizeExpenseTax({ amount: 10, taxPaid: { GST: 8, QST: 8 } }, REGISTERED, {}))
      .toThrow(/cannot exceed/);
  });

  it('rejects negative tax', () => {
    expect(() => normalizeExpenseTax({ amount: 100, taxPaid: { GST: -1 } }, REGISTERED, {}))
      .toThrow(/cannot be negative/);
  });

  it('extracts nothing for a purchase made before registration', () => {
    const profile = resolveTaxProfile({
      province: 'QC', salesTaxRegistered: true, salesTaxRegisteredSince: '2026-06-01'
    });
    const before = normalizeExpenseTax({ amount: 114.98 }, profile, { date: '2026-03-10' });
    const after = normalizeExpenseTax({ amount: 114.98 }, profile, { date: '2026-08-10' });
    expect(before.taxPaid).toEqual({});
    expect(after.taxPaid.GST).toBe(5);
  });
});

// The whole point of the exercise: a transaction entered through the form now
// produces the same numbers as the hand-built fixtures in the other suites.
describe('end to end: form input to deduction', () => {
  it('deducts the pre-tax cost and claims the full credit on a normal expense', () => {
    const stored = {
      amount: 114.98,
      category: 'Office Supplies',
      ...normalizeExpenseTax({ amount: 114.98 }, REGISTERED, { date: '2026-08-10' })
    };
    expect(deductibleExpenseAmount(stored, REGISTERED)).toBe(100);
    expect(recoverableTax(stored, REGISTERED)).toBe(14.98);
  });

  it('halves both the deduction and the credit on a client meal', () => {
    const stored = {
      amount: 114.98,
      category: 'Client Meals',
      ...normalizeExpenseTax({ amount: 114.98 }, REGISTERED, { date: '2026-08-10' })
    };
    expect(isDeductionCapped('Client Meals')).toBe(true);
    expect(deductibleExpenseAmount(stored, REGISTERED)).toBe(50);
    expect(recoverableTax(stored, REGISTERED)).toBe(7.49);
  });

  it('scales both by business use on a part-personal purchase', () => {
    const stored = {
      amount: 2298,
      category: 'Equipment',
      ...normalizeExpenseTax({ amount: 2298, deductiblePercent: 60 }, REGISTERED, { date: '2026-08-10' })
    };
    expect(deductibleExpenseAmount(stored, REGISTERED)).toBe(1199.22);
    expect(recoverableTax(stored, REGISTERED)).toBe(179.58);
  });
});
