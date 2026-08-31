import { buildOverview } from '../domain/business/overview.js';
import { receivablesAging } from '../domain/business/receivables.js';
import { resolveTaxProfile } from '../domain/business/rates.js';
import { assertBasis } from '../domain/business/periods.js';
import { ValidationError } from '../domain/errors.js';

// Assembles the business overview from two repositories and hands the numbers
// to the domain layer. No arithmetic happens in this file — if a calculation
// appears here rather than in domain/business, it has escaped its layer.

const PERIOD = /^\d{4}-\d{2}$/;

export function createBusinessOverviewService({ invoiceRepo, transactionRepo }) {
  return {
    async get(ctx, { period, basis = 'cash', today }) {
      if (!PERIOD.test(period || '')) {
        throw new ValidationError('period must be in YYYY-MM format');
      }
      assertBasis(basis);

      const [invoices, expenses] = await Promise.all([
        invoiceRepo.list(ctx),
        transactionRepo.listInPeriod(ctx, period)
      ]);

      const taxProfile = resolveTaxProfile(ctx.taxProfile || {});

      const overview = buildOverview({
        revenues: invoices,
        expenses,
        period,
        basis,
        taxProfile,
        structure: ctx.businessStructure || 'soleProp'
      });

      return {
        ...overview,
        receivables: receivablesAging(invoices, today),
        // Transactions currently carry no GST/QST breakdown, which pulls two
        // figures in opposite directions: with no recorded tax the full
        // tax-inclusive amount is deducted (overstating deductions) and no
        // input tax credit is claimed (overstating tax owed). Reporting the
        // count lets the UI say so plainly instead of presenting a confident
        // number built on missing data.
        dataQuality: dataQualityOf(expenses, taxProfile)
      };
    }
  };
}

function dataQualityOf(expenses, taxProfile) {
  if (!taxProfile.salesTaxRegistered) {
    return { expensesMissingTax: 0, applies: false };
  }
  const missing = expenses.filter(
    e => e.gstPaid === undefined && e.qstPaid === undefined
  ).length;
  return {
    applies: true,
    expensesMissingTax: missing,
    expensesTotal: expenses.length
  };
}
