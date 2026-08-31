import { describe, it, expect } from 'vitest';
import {
  effectiveDeductiblePercent,
  deductibleAmount,
  calcSalesTax,
  recoverableTax,
  netSalesTax,
  deductibleExpenseAmount,
  recognitionDate,
  revenuesInPeriod,
  structureFor,
  isImplemented,
  receivablesAging,
  buildOverview,
  resolveTaxProfile
} from '../domain/business/index.js';

// Quebec explicitly: it is the two-component province, so it exercises the
// map shape more thoroughly than a single-tax province would.
const REGISTERED = resolveTaxProfile({ province: 'QC', salesTaxRegistered: true, incomeTaxReservePercent: 30 });
const UNREGISTERED = resolveTaxProfile({ province: 'QC', salesTaxRegistered: false });
const ONTARIO = resolveTaxProfile({ province: 'ON', salesTaxRegistered: true, incomeTaxReservePercent: 30 });

describe('effectiveDeductiblePercent', () => {
  it('defaults to fully deductible', () => {
    expect(effectiveDeductiblePercent({ category: 'Office Supplies' })).toBe(100);
  });

  it('applies the declared business-use share', () => {
    expect(effectiveDeductiblePercent({ category: 'Equipment', deductiblePercent: 60 })).toBe(60);
  });

  it('caps meals at 50% even when declared fully business', () => {
    expect(effectiveDeductiblePercent({ category: 'Client Meals', deductiblePercent: 100 })).toBe(50);
  });

  it('compounds business use with the statutory cap', () => {
    // 80% business use of a category capped at 50% is 40%, not 50%.
    expect(effectiveDeductiblePercent({ category: 'Client Meals', deductiblePercent: 80 })).toBe(40);
  });
});

describe('deductibleAmount', () => {
  it('deducts the full tax-inclusive amount when not registered', () => {
    const expense = { amount: 114.98, category: 'Office Supplies', taxPaid: { GST: 5, QST: 9.98 } };
    expect(deductibleExpenseAmount(expense, UNREGISTERED)).toBe(114.98);
  });

  it('deducts only the pre-tax cost for a registrant', () => {
    // $100 + $5 GST + $9.98 QST. The tax comes back as an input credit, so
    // deducting it as well would claim the same dollar twice.
    const expense = { amount: 114.98, category: 'Office Supplies', taxPaid: { GST: 5, QST: 9.98 } };
    expect(deductibleExpenseAmount(expense, REGISTERED)).toBe(100);
  });

  it('deducts the pre-tax cost of an Ontario HST purchase', () => {
    const expense = { amount: 113, category: 'Office Supplies', taxPaid: { HST: 13 } };
    expect(deductibleExpenseAmount(expense, ONTARIO)).toBe(100);
  });

  // PST is never recoverable, so it is a real cost and stays in the base.
  // Treating it like GST would understate the deduction on every BC purchase.
  it('keeps non-recoverable PST in the deductible base', () => {
    const bc = resolveTaxProfile({ province: 'BC', salesTaxRegistered: true });
    const expense = { amount: 112, category: 'Office Supplies', taxPaid: { GST: 5, PST: 7 } };
    expect(deductibleExpenseAmount(expense, bc)).toBe(107);
  });

  it('applies the meals cap on top of the pre-tax base', () => {
    const meal = { amount: 114.98, category: 'Client Meals', deductiblePercent: 100, taxPaid: { GST: 5, QST: 9.98 } };
    expect(deductibleExpenseAmount(meal, REGISTERED)).toBe(50);
  });
});

describe('calcSalesTax', () => {
  it('charges QST on the pre-GST subtotal, not on the GST-inclusive total', () => {
    const { components, total } = calcSalesTax(100, REGISTERED);
    expect(components.GST).toBe(5);
    expect(components.QST).toBe(9.98); // 100 * 0.09975, not 105 * 0.09975
    expect(total).toBe(114.98);
  });

  it('charges a single combined HST in Ontario', () => {
    const { components, total } = calcSalesTax(100, ONTARIO);
    expect(components).toEqual({ HST: 13 });
    expect(total).toBe(113);
  });

  it('charges GST and non-recoverable PST in British Columbia', () => {
    const bc = resolveTaxProfile({ province: 'BC', salesTaxRegistered: true });
    expect(calcSalesTax(100, bc).components).toEqual({ GST: 5, PST: 7 });
  });

  it('charges nothing when not registered', () => {
    expect(calcSalesTax(100, UNREGISTERED)).toMatchObject({ components: {}, total: 100 });
  });
});

describe('recoverableTax', () => {
  it('is zero when not registered', () => {
    const expense = { amount: 114.98, category: 'Office Supplies', gstPaid: 5, qstPaid: 9.98 };
    expect(recoverableTax(expense, UNREGISTERED)).toBe(0);
  });

  it('limits the credit on meals to the same 50% as the deduction', () => {
    const meal = { amount: 114.98, category: 'Client Meals', deductiblePercent: 100, gstPaid: 5, qstPaid: 9.98 };
    expect(recoverableTax(meal, REGISTERED)).toBe(7.49);
  });

  it('limits the credit to the business-use share', () => {
    const laptop = { amount: 2298, category: 'Equipment', deductiblePercent: 60, gstPaid: 100, qstPaid: 199.5 };
    expect(recoverableTax(laptop, REGISTERED)).toBe(179.7);
  });
});

describe('netSalesTax', () => {
  it('nets credits against tax collected', () => {
    const revenues = [{ subtotal: 1000, gstCollected: 50, qstCollected: 99.75 }];
    const expenses = [{ amount: 114.98, category: 'Office Supplies', gstPaid: 5, qstPaid: 9.98 }];
    const result = netSalesTax(revenues, expenses, REGISTERED);
    expect(result.collected).toBe(149.75);
    expect(result.inputCredits).toBe(14.98);
    expect(result.net).toBe(134.77);
    expect(result.isRefund).toBe(false);
  });

  it('flags a refund when credits exceed tax collected', () => {
    const expenses = [{ amount: 2298, category: 'Equipment', gstPaid: 100, qstPaid: 199.5 }];
    const result = netSalesTax([], expenses, REGISTERED);
    expect(result.net).toBeLessThan(0);
    expect(result.isRefund).toBe(true);
  });
});

describe('cash vs accrual recognition', () => {
  const invoices = [
    { subtotal: 4000, issuedDate: '2026-03-20', paidDate: '2026-04-15' },
    { subtotal: 1500, issuedDate: '2026-03-02', paidDate: null }
  ];

  it('recognizes on issue date under accrual', () => {
    expect(recognitionDate(invoices[0], 'accrual')).toBe('2026-03-20');
    expect(revenuesInPeriod(invoices, '2026-03', 'accrual')).toHaveLength(2);
  });

  it('recognizes on payment date under cash', () => {
    expect(recognitionDate(invoices[0], 'cash')).toBe('2026-04-15');
    expect(revenuesInPeriod(invoices, '2026-03', 'cash')).toHaveLength(0);
    expect(revenuesInPeriod(invoices, '2026-04', 'cash')).toHaveLength(1);
  });

  it('never counts an unpaid invoice as cash revenue', () => {
    const allPeriods = ['2026-03', '2026-04', '2026-05'];
    const counted = allPeriods.flatMap(p => revenuesInPeriod(invoices, p, 'cash'));
    expect(counted.some(r => r.paidDate === null)).toBe(false);
  });

  it('rejects an unknown basis instead of guessing', () => {
    expect(() => revenuesInPeriod(invoices, '2026-03', 'whatever')).toThrow(/basis must be/);
  });
});

describe('structures', () => {
  it('reserves income tax as a share of net profit for a sole prop', () => {
    expect(structureFor('soleProp').incomeTaxReserve(10000, REGISTERED)).toBe(3000);
  });

  it('reserves nothing on a loss', () => {
    expect(structureFor('soleProp').incomeTaxReserve(-500, REGISTERED)).toBe(0);
  });

  it('treats an owner draw as non-deductible', () => {
    expect(structureFor('soleProp').ownerPayIsDeductible).toBe(false);
  });

  it('registers corporation but reports it as not implemented', () => {
    expect(structureFor('corporation')).toBeDefined();
    expect(isImplemented('corporation')).toBe(false);
    expect(() => structureFor('corporation').incomeTaxReserve(1000, REGISTERED)).toThrow(/not implemented/);
  });

  it('rejects an unknown structure', () => {
    expect(() => structureFor('partnership')).toThrow(/Unknown business structure/);
  });
});

describe('receivablesAging', () => {
  const today = '2026-08-28';
  const invoices = [
    { subtotal: 1000, gstCollected: 50, qstCollected: 99.75, dueDate: '2026-09-30', paidDate: null },
    { subtotal: 2000, gstCollected: 100, qstCollected: 199.5, dueDate: '2026-08-01', paidDate: null },
    { subtotal: 3000, gstCollected: 150, qstCollected: 299.25, dueDate: '2026-05-01', paidDate: null },
    { subtotal: 5000, gstCollected: 250, qstCollected: 498.75, dueDate: '2026-07-01', paidDate: '2026-07-10' }
  ];

  it('excludes paid invoices', () => {
    expect(receivablesAging(invoices, today).count).toBe(3);
  });

  it('totals the tax-inclusive amount owed', () => {
    expect(receivablesAging(invoices, today).total).toBe(6898.5);
  });

  it('separates overdue from not-yet-due', () => {
    const { overdue, buckets } = receivablesAging(invoices, today);
    expect(buckets.current.count).toBe(1);
    expect(overdue).toBe(5748.75);
  });

  it('buckets by how far past due', () => {
    const { buckets } = receivablesAging(invoices, today);
    expect(buckets.d1_30.count).toBe(1);   // due Aug 1, 27 days late
    expect(buckets.d90_plus.count).toBe(1); // due May 1, 119 days late
  });

  it('treats an invoice with no due date as not yet due', () => {
    const { buckets } = receivablesAging([{ subtotal: 100, paidDate: null }], today);
    expect(buckets.current.count).toBe(1);
  });
});

describe('buildOverview', () => {
  const revenues = [
    { subtotal: 8000, gstCollected: 400, qstCollected: 798, issuedDate: '2026-07-25', paidDate: '2026-08-05' },
    { subtotal: 3000, gstCollected: 150, qstCollected: 299.25, issuedDate: '2026-08-20', paidDate: null }
  ];
  const expenses = [
    { amount: 2298, category: 'Equipment', date: '2026-08-10', deductiblePercent: 60, gstPaid: 100, qstPaid: 199.5 },
    { amount: 114.98, category: 'Client Meals', date: '2026-08-12', deductiblePercent: 100, gstPaid: 5, qstPaid: 9.98 }
  ];

  const cash = buildOverview({
    revenues, expenses, period: '2026-08', basis: 'cash', taxProfile: REGISTERED
  });

  it('excludes sales tax collected from revenue', () => {
    // The August-paid invoice only — and its $1,198 of tax is not revenue.
    expect(cash.revenue).toBe(8000);
  });

  it('separates cash out from what is actually deductible', () => {
    expect(cash.expensesTotal).toBe(2412.98);
    expect(cash.deductibleExpenses).toBe(1249.1);
    expect(cash.nonDeductibleExpenses).toBe(1163.88);
  });

  it('computes net profit from deductible expenses, not gross spend', () => {
    expect(cash.netProfit).toBe(6750.9);
  });

  it('reserves sales tax and income tax separately', () => {
    expect(cash.salesTax.net).toBe(1010.81);
    expect(cash.incomeTaxReserve).toBe(2025.27);
    expect(cash.totalSetAside).toBe(3036.08);
  });

  it('reports a different revenue figure on accrual', () => {
    const accrual = buildOverview({
      revenues, expenses, period: '2026-08', basis: 'accrual', taxProfile: REGISTERED
    });
    expect(accrual.revenue).toBe(3000);
    expect(accrual.revenue).not.toBe(cash.revenue);
  });

  it('always marks its output as an estimate', () => {
    expect(cash.isEstimate).toBe(true);
  });

  it('refuses to run without an explicit basis', () => {
    expect(() => buildOverview({ revenues, expenses, period: '2026-08' })).toThrow(/basis must be/);
  });
});
