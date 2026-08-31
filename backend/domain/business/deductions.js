// What portion of an expense actually reduces taxable profit.
//
// This is the distinction a personal tracker never needs and a business one
// lives on: "expenses" (cash out the door) and "deductions" (what the tax
// return sees) are two different numbers, and users conflate them constantly.

// Statutory caps that apply regardless of how the user classifies the expense.
// Meals and entertainment are limited to 50% in Canada — someone can declare
// a client dinner 100% business and it is still only half deductible.
export const CATEGORY_DEDUCTION_LIMITS = {
  'Client Meals': 50,
  'Entertainment': 50
};

// Business-use share and statutory cap compound rather than override each
// other. A laptop at 60% business use in an uncapped category is 60%. A
// client meal at 100% business use is 50%. A meal at 80% use is 40% — both
// constraints bind at once, so the smaller-of rule would be wrong here.
export function effectiveDeductiblePercent(expense) {
  const declared = expense.deductiblePercent ?? 100;
  const cap = CATEGORY_DEDUCTION_LIMITS[expense.category] ?? 100;
  return (clampPercent(declared) * clampPercent(cap)) / 100;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, value));
}

// The base an expense is deducted from, before the business-use share.
//
// Expense amounts are tax-INCLUSIVE, because that is what a receipt or bank
// statement shows. Only RECOVERABLE tax comes out of the base: a registrant
// gets GST/HST/QST back as an input credit, so deducting it too would claim
// the same dollar twice. Non-recoverable tax (PST in BC, SK and MB) never
// comes back, so it is a genuine cost and stays in the base.
//
// Approximation worth knowing about: on a partly-personal purchase, the
// portion of recoverable tax that is NOT actually reclaimed can in some cases
// be added back to the cost. This models the simple case and does not. The
// gap always errs toward under-claiming, and it is the sort of thing to raise
// with an accountant rather than have a tool decide silently.
export function deductibleBase(expense, taxProfile = {}, recoverable = 0) {
  const amount = Number(expense.amount) || 0;
  if (!taxProfile.salesTaxRegistered) return round2(amount);
  return round2(Math.max(0, amount - recoverable));
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Kept out of deductions.js's own imports to avoid a cycle: salesTax.js
// imports effectiveDeductiblePercent from here, so this helper lives in
// expenses.js instead and is re-exported through the barrel.
