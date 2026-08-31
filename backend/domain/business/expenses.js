import { ValidationError } from '../errors.js';
import {
  extractSalesTax, recoverableFrom, taxesPaidOn, recoverableTax
} from './salesTax.js';
import { taxProfileOn } from './rates.js';
import {
  CATEGORY_DEDUCTION_LIMITS, effectiveDeductiblePercent, deductibleBase, round2
} from './deductions.js';

// Turns what a business user can reasonably be asked for into the fields the
// tax math needs.
//
// The user supplies an amount from a receipt, a category, optionally what
// share was business use, and whether the price included sales tax.
// Everything else is derived — nobody types a tax figure off a receipt for a
// $4 coffee, and a field that stays empty is worse than no field at all.

export function isDeductionCapped(category) {
  return CATEGORY_DEDUCTION_LIMITS[category] !== undefined;
}

// Lives here rather than in deductions.js because it needs the recoverable
// split from salesTax.js, and salesTax.js already imports from deductions.js.
export function deductibleAmount(expense, taxProfile = {}) {
  const recoverable = taxProfile.salesTaxRegistered
    ? recoverableFrom(taxesPaidOn(expense), taxProfile)
    : 0;
  const base = deductibleBase(expense, taxProfile, recoverable);
  return round2((base * effectiveDeductiblePercent(expense)) / 100);
}

export function normalizeExpenseTax(input, taxProfile, { date } = {}) {
  const amount = Number(input.amount) || 0;

  let deductiblePercent = 100;
  if (input.deductiblePercent !== undefined && input.deductiblePercent !== null && input.deductiblePercent !== '') {
    const pct = Number(input.deductiblePercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new ValidationError('deductiblePercent must be between 0 and 100');
    }
    deductiblePercent = round2(pct);
  }

  // Registration is evaluated on the transaction date, matching invoices — a
  // purchase made before registering carries no recoverable tax however the
  // flag stands today.
  const profileThen = taxProfileOn(taxProfile, date);

  // An explicit map always wins: imported statements and unusual receipts
  // (mixed rates, out-of-province, exempt lines) cannot be derived from a
  // total. Legacy gstPaid/qstPaid are accepted here too.
  const explicit = input.taxPaid && typeof input.taxPaid === 'object'
    ? input.taxPaid
    : (input.gstPaid !== undefined || input.qstPaid !== undefined
        ? { GST: Number(input.gstPaid) || 0, QST: Number(input.qstPaid) || 0 }
        : null);

  if (explicit) {
    const taxPaid = {};
    let total = 0;
    for (const [code, value] of Object.entries(explicit)) {
      const amt = round2(Number(value) || 0);
      if (amt < 0) throw new ValidationError('Sales tax amounts cannot be negative');
      if (amt !== 0) taxPaid[code] = amt;
      total = round2(total + amt);
    }
    if (total > amount) {
      throw new ValidationError('Sales tax cannot exceed the transaction amount');
    }
    return { deductiblePercent, taxPaid, salesTaxIncluded: total > 0 };
  }

  // Default to "tax was included" for a registrant, because for most business
  // purchases it was. Defaulting to false would quietly reproduce the exact
  // zero-credit problem these fields exist to fix.
  const salesTaxIncluded = input.salesTaxIncluded !== undefined
    ? !!input.salesTaxIncluded
    : profileThen.salesTaxRegistered;

  if (!salesTaxIncluded || !profileThen.salesTaxRegistered) {
    return { deductiblePercent, taxPaid: {}, salesTaxIncluded: false };
  }

  const { components } = extractSalesTax(amount, profileThen);
  return { deductiblePercent, taxPaid: components, salesTaxIncluded: true };
}

export { recoverableTax };

// Older name for the same calculation, kept so callers written against the
// pre-province-table API keep working.
export { deductibleAmount as deductibleExpenseAmount };
