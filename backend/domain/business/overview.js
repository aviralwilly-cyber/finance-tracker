import { round2 } from './deductions.js';
import { deductibleAmount } from './expenses.js';
import { netSalesTax } from './salesTax.js';
import { revenuesInPeriod, expensesInPeriod, assertBasis } from './periods.js';
import { structureFor } from './structures.js';
import { resolveTaxProfile } from './rates.js';

// The business counterpart to the personal /api/overview.
//
// Worth stating plainly why this could not have been a variation on the
// personal one: personal income is a *standing fact* — configured once,
// repeating, resolved by incomeInEffectOn(). Business revenue is a series
// of discrete irregular events. There is no "monthly income in effect on a
// date" for a freelancer, so the concept the personal overview is built
// around simply does not exist here.

export function buildOverview({
  revenues = [],
  expenses = [],
  period,
  basis,
  taxProfile: partialProfile = {},
  structure = 'soleProp'
} = {}) {
  assertBasis(basis);
  if (!period) throw new Error('period is required (YYYY-MM)');

  const taxProfile = resolveTaxProfile(partialProfile);
  const rules = structureFor(structure);

  const periodRevenues = revenuesInPeriod(revenues, period, basis);
  const periodExpenses = expensesInPeriod(expenses, period);

  // Revenue is always ex-tax. Sales tax collected was never the business's
  // money — it is held on behalf of the government — so folding it into
  // revenue inflates every downstream figure including the tax reserve.
  const revenue = round2(
    periodRevenues.reduce((sum, r) => sum + (Number(r.subtotal) || 0), 0)
  );

  const expensesTotal = round2(
    periodExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
  );

  const deductibleExpenses = round2(
    periodExpenses.reduce((sum, e) => sum + deductibleAmount(e, taxProfile), 0)
  );

  const netProfit = round2(revenue - deductibleExpenses);
  const salesTax = netSalesTax(periodRevenues, periodExpenses, taxProfile);
  const incomeTaxReserve = rules.incomeTaxReserve(netProfit, taxProfile);

  // The number this whole module exists to produce: how much of the bank
  // balance is already committed and is not the owner's to spend.
  const totalSetAside = round2(Math.max(0, salesTax.net) + incomeTaxReserve);

  return {
    period,
    basis,
    structure: rules.id,
    revenue,
    expensesTotal,
    deductibleExpenses,
    // Cash out that is not deductible — the gap users are surprised by.
    nonDeductibleExpenses: round2(expensesTotal - deductibleExpenses),
    netProfit,
    salesTax,
    incomeTaxReserve,
    totalSetAside,
    // Cash actually available after obligations, on a cash basis.
    availableAfterObligations: round2(revenue - expensesTotal - totalSetAside),
    // Every figure here is an estimate for planning, not a filing figure.
    // The route returns this so the UI cannot quietly drop the caveat.
    isEstimate: true
  };
}
