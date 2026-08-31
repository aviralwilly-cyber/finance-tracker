// Single import surface for the business domain. Services import from here;
// nothing outside domain/business/ should reach into the individual files.
//
// Same contract as lib.js: pure input → output, no Firestore, no Express,
// no Groq. Nothing in this directory may import from any of them.

export {
  DEFAULT_TAX_PROFILE, DEFAULT_PROVINCE, PROVINCES, PROVINCE_LABELS,
  PROVINCE_TAXES, componentsFor, isKnownProvince,
  resolveTaxProfile, taxProfileOn, taxMapOf
} from './rates.js';

export {
  CATEGORY_DEDUCTION_LIMITS,
  effectiveDeductiblePercent,
  deductibleBase
} from './deductions.js';

export {
  calcSalesTax, extractSalesTax, recoverableTax, recoverableFrom,
  netSalesTax, sumTaxes, sumTaxes as sumTax, taxesPaidOn, taxesCollectedOn
} from './salesTax.js';

export {
  normalizeExpenseTax, isDeductionCapped, deductibleAmount, deductibleExpenseAmount
} from './expenses.js';

export {
  BASES, recognitionDate, revenuesInPeriod, expensesInPeriod
} from './periods.js';

export { STRUCTURES, IMPLEMENTED_STRUCTURES, structureFor, isImplemented } from './structures.js';
export { AGING_BUCKETS, receivablesAging } from './receivables.js';
export { buildOverview } from './overview.js';
export {
  normalizeBusinessSettings, structureOptions, provinceOptions, defaultBusinessSettings
} from './settings.js';
export { INVOICE_STATUSES, normalizeInvoice, statusOf, withStatus } from './invoices.js';
