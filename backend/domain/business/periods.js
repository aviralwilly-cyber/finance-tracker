// Cash vs accrual, made explicit.
//
// A revenue record carries both issuedDate (when the invoice went out) and
// paidDate (when the money landed, null while outstanding). Storing both is
// what lets the dashboard show cash — what is actually in the bank — while
// the tax view shows accrual, without either number being reconstructed or
// guessed after the fact.
//
// Every function that reduces revenue to a number takes an explicit basis.
// There is no default at this layer on purpose: a caller that forgets to
// pass one should fail loudly rather than silently pick a basis and produce
// a number that disagrees with the card next to it.

export const BASES = ['cash', 'accrual'];

export function assertBasis(basis) {
  if (!BASES.includes(basis)) {
    throw new Error(`basis must be one of ${BASES.join(', ')} — got ${basis}`);
  }
  return basis;
}

// Which date decides whether a revenue record belongs to a period.
// Cash basis ignores unpaid invoices entirely; they are receivables, not
// revenue, until the money arrives.
export function recognitionDate(revenue, basis) {
  assertBasis(basis);
  return basis === 'cash' ? revenue.paidDate || null : revenue.issuedDate || null;
}

// Periods are 'YYYY-MM' prefixes, matching how the rest of the app slices
// time (see lastNMonths and the overview route).
export function inPeriod(dateStr, period) {
  return typeof dateStr === 'string' && dateStr.startsWith(period);
}

export function revenuesInPeriod(revenues, period, basis) {
  assertBasis(basis);
  return revenues.filter(r => inPeriod(recognitionDate(r, basis), period));
}

// Expenses use a single date and behave the same on both bases here. A
// strict accrual treatment would separate invoice date from payment date for
// bills too; that is deliberately out of scope until there is a reason for
// it, and this comment is the marker for where it would go.
export function expensesInPeriod(expenses, period) {
  return expenses.filter(e => inPeriod(e.date, period));
}
