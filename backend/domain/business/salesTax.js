import { effectiveDeductiblePercent, round2 } from './deductions.js';
import { taxMapOf, COLLECTED_LEGACY, PAID_LEGACY } from './rates.js';

// Sales tax computed from a province's component list.
//
// Every component applies to the same pre-tax base. That is not a
// simplification: Quebec's QST is charged on the price excluding GST, and
// HST is a single tax on the pre-tax price, so "all components on the
// subtotal" is the correct rule everywhere in the table.

export function calcSalesTax(subtotal, taxProfile) {
  const base = round2(Number(subtotal) || 0);
  if (!taxProfile.salesTaxRegistered) {
    return { subtotal: base, components: {}, taxTotal: 0, total: base };
  }
  const components = {};
  let taxTotal = 0;
  for (const component of taxProfile.components) {
    const amount = round2(base * component.rate);
    components[component.code] = amount;
    taxTotal = round2(taxTotal + amount);
  }
  return { subtotal: base, components, taxTotal, total: round2(base + taxTotal) };
}

// The inverse: given a tax-INCLUSIVE total, work out the components.
//
// This is what makes the expense form usable — a receipt shows one number,
// and asking for three guarantees the fields stay empty. The last component
// is reconciled by subtraction so base + taxes always equals the original
// amount to the cent; a rounding gap in a remittance figure is expensive.
export function extractSalesTax(totalInclusive, taxProfile) {
  const total = round2(Number(totalInclusive) || 0);
  if (!taxProfile.salesTaxRegistered || total <= 0) {
    return { base: total, components: {}, taxTotal: 0 };
  }
  const divisor = taxProfile.components.reduce((sum, c) => sum + c.rate, 1);
  const base = round2(total / divisor);

  const components = {};
  let running = base;
  taxProfile.components.forEach((component, i) => {
    const isLast = i === taxProfile.components.length - 1;
    const amount = isLast ? round2(total - running) : round2(base * component.rate);
    components[component.code] = amount;
    running = round2(running + amount);
  });

  return { base, components, taxTotal: round2(total - base) };
}

// Sum of a tax map, counting only components that can actually be claimed
// back. PST is excluded because it is not recoverable — a business cannot
// reclaim it, which makes it a real cost rather than a pass-through.
export function recoverableFrom(amounts, taxProfile) {
  let sum = 0;
  for (const component of taxProfile.components) {
    if (!component.recoverable) continue;
    sum = round2(sum + (Number(amounts[component.code]) || 0));
  }
  return sum;
}

export function taxesPaidOn(expense) {
  return taxMapOf(expense, 'taxPaid', PAID_LEGACY);
}

export function taxesCollectedOn(revenue) {
  return taxMapOf(revenue, 'taxCollected', COLLECTED_LEGACY);
}

export function sumTaxes(amounts) {
  return round2(Object.values(amounts).reduce((sum, v) => sum + (Number(v) || 0), 0));
}

// Sales tax paid on an expense that the business can actually claim back.
//
// Restricted to the business-use portion, and the same 50% cap that limits
// the meals deduction limits the credit on meals — hence reusing
// effectiveDeductiblePercent rather than reading deductiblePercent directly,
// which would over-claim on every client dinner.
export function recoverableTax(expense, taxProfile) {
  if (!taxProfile.salesTaxRegistered) return 0;
  const recoverable = recoverableFrom(taxesPaidOn(expense), taxProfile);
  return round2((recoverable * effectiveDeductiblePercent(expense)) / 100);
}

// What is owed for a period: tax collected on sales, less credits on
// purchases. A negative result is a refund, not a debt.
export function netSalesTax(revenues, expenses, taxProfile) {
  const collected = revenues.reduce(
    (sum, r) => round2(sum + sumTaxes(taxesCollectedOn(r))), 0
  );
  const credits = expenses.reduce((sum, e) => round2(sum + recoverableTax(e, taxProfile)), 0);
  const net = round2(collected - credits);
  return { collected: round2(collected), inputCredits: round2(credits), net, isRefund: net < 0 };
}
