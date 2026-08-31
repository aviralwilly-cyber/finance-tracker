import { describe, it, expect } from 'vitest';
import { createBusinessOverviewService } from '../services/businessOverviewService.js';
import { resolveTaxProfile } from '../domain/business/rates.js';

const TODAY = '2026-08-29';

// Two invoices: one paid in August (cash revenue), one issued in August but
// still unpaid (accrual revenue, and a receivable either way).
const INVOICES = [
  {
    id: 'a', clientName: 'Acme', subtotal: 8000, gstCollected: 400, qstCollected: 798,
    issuedDate: '2026-07-25', dueDate: '2026-08-10', paidDate: '2026-08-05'
  },
  {
    id: 'b', clientName: 'Globex', subtotal: 3000, gstCollected: 150, qstCollected: 299.25,
    issuedDate: '2026-08-20', dueDate: '2026-09-19', paidDate: null
  }
];

const EXPENSES = [
  { id: 't1', description: 'Laptop', amount: 2298, category: 'Equipment', date: '2026-08-10', deductiblePercent: 60, gstPaid: 100, qstPaid: 199.5 },
  { id: 't2', description: 'Client lunch', amount: 114.98, category: 'Client Meals', date: '2026-08-12', gstPaid: 5, qstPaid: 9.98 }
];

function build({ invoices = INVOICES, expenses = EXPENSES } = {}) {
  return createBusinessOverviewService({
    invoiceRepo: { async list() { return invoices; } },
    transactionRepo: { async listInPeriod() { return expenses; } }
  });
}

const CTX = {
  uid: 'u1',
  accountId: 'default',
  accountType: 'business',
  taxProfile: resolveTaxProfile({ province: 'QC', salesTaxRegistered: true, incomeTaxReservePercent: 30 }),
  businessStructure: 'soleProp'
};

describe('businessOverviewService', () => {
  it('reports cash revenue excluding sales tax collected', async () => {
    const result = await build().get(CTX, { period: '2026-08', basis: 'cash', today: TODAY });
    // Only the July invoice paid in August counts on a cash basis, and its
    // $1,198 of tax was never revenue.
    expect(result.revenue).toBe(8000);
  });

  it('reports a different revenue figure on accrual', async () => {
    const result = await build().get(CTX, { period: '2026-08', basis: 'accrual', today: TODAY });
    expect(result.revenue).toBe(3000);
  });

  it('separates cash out from deductible spend', async () => {
    const result = await build().get(CTX, { period: '2026-08', basis: 'cash', today: TODAY });
    expect(result.expensesTotal).toBe(2412.98);
    expect(result.deductibleExpenses).toBe(1249.1);
    expect(result.nonDeductibleExpenses).toBe(1163.88);
  });

  it('computes the set-aside from sales tax and income tax together', async () => {
    const result = await build().get(CTX, { period: '2026-08', basis: 'cash', today: TODAY });
    expect(result.salesTax.net).toBe(1010.81);
    expect(result.incomeTaxReserve).toBe(2025.27);
    expect(result.totalSetAside).toBe(3036.08);
  });

  it('includes receivables aging alongside the overview', async () => {
    const result = await build().get(CTX, { period: '2026-08', basis: 'cash', today: TODAY });
    expect(result.receivables.count).toBe(1);
    expect(result.receivables.total).toBe(3449.25);
    expect(result.receivables.overdue).toBe(0);
  });

  it('always marks its numbers as estimates', async () => {
    const result = await build().get(CTX, { period: '2026-08', basis: 'cash', today: TODAY });
    expect(result.isEstimate).toBe(true);
  });

  it('rejects a malformed period instead of guessing', async () => {
    await expect(build().get(CTX, { period: 'August', basis: 'cash', today: TODAY }))
      .rejects.toThrow(/YYYY-MM/);
  });

  it('rejects an unknown basis', async () => {
    await expect(build().get(CTX, { period: '2026-08', basis: 'vibes', today: TODAY }))
      .rejects.toThrow(/basis must be/);
  });

  it('handles an account with no invoices or expenses', async () => {
    const result = await build({ invoices: [], expenses: [] })
      .get(CTX, { period: '2026-08', basis: 'cash', today: TODAY });
    expect(result.revenue).toBe(0);
    expect(result.netProfit).toBe(0);
    expect(result.totalSetAside).toBe(0);
    expect(result.receivables.count).toBe(0);
  });

  describe('data quality', () => {
    it('counts expenses with no recorded sales tax', async () => {
      const service = build({
        expenses: [
          { amount: 100, category: 'Office Supplies', date: '2026-08-01' },
          { amount: 200, category: 'Software', date: '2026-08-02' },
          { amount: 50, category: 'Software', date: '2026-08-03', gstPaid: 2.5, qstPaid: 5 }
        ]
      });
      const result = await service.get(CTX, { period: '2026-08', basis: 'cash', today: TODAY });
      expect(result.dataQuality.applies).toBe(true);
      expect(result.dataQuality.expensesMissingTax).toBe(2);
      expect(result.dataQuality.expensesTotal).toBe(3);
    });

    // Nothing to warn about if the business does not collect or recover tax.
    it('does not apply when the account is not registered', async () => {
      const unregistered = { ...CTX, taxProfile: resolveTaxProfile({ province: 'QC', salesTaxRegistered: false }) };
      const result = await build().get(unregistered, { period: '2026-08', basis: 'cash', today: TODAY });
      expect(result.dataQuality.applies).toBe(false);
    });
  });
});
