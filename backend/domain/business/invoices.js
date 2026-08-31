import { ValidationError } from '../errors.js';
import { taxProfileOn } from './rates.js';
import { calcSalesTax, sumTaxes } from './salesTax.js';
import { round2 } from './deductions.js';

// Invoice shape and rules. Pure — no Firestore, no Express, no clock.
//
// `today` is always passed in rather than read from Date.now(), because a
// status that depends on a hidden clock cannot be tested and drifts silently
// across timezones. The caller owns the notion of "now".

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const INVOICE_STATUSES = ['draft', 'outstanding', 'overdue', 'paid'];

function requireIsoDate(value, field) {
  if (!ISO_DATE.test(value || '')) {
    throw new ValidationError(`${field} must be a date in YYYY-MM-DD format`);
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} is not a real date`);
  }
  return value;
}

function optionalIsoDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requireIsoDate(value, field);
}

// Takes raw request input and returns a storable invoice, or throws.
//
// Sales tax is computed here rather than trusted from the client: the amounts
// feed the GST/QST remittance figure, and a client that sends its own numbers
// can silently corrupt what the user eventually files. Explicit overrides are
// allowed for imported historical invoices, where the real charged amount
// matters more than what the current rate would produce.
export function normalizeInvoice(input = {}, taxProfile) {
  if (!taxProfile) throw new ValidationError('taxProfile is required');

  const clientName = String(input.clientName || '').trim();
  if (!clientName) throw new ValidationError('clientName is required');

  const subtotal = Number(input.subtotal);
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    throw new ValidationError('subtotal must be a positive number');
  }

  const issuedDate = requireIsoDate(input.issuedDate, 'issuedDate');
  const dueDate = optionalIsoDate(input.dueDate, 'dueDate');
  const paidDate = optionalIsoDate(input.paidDate, 'paidDate');

  if (dueDate && dueDate < issuedDate) {
    throw new ValidationError('dueDate cannot be before issuedDate');
  }
  if (paidDate && paidDate < issuedDate) {
    throw new ValidationError('paidDate cannot be before issuedDate');
  }

  // Tax is computed against the profile as it stood on the ISSUE date, not as
  // it stands today. Registering next month must not add tax to an invoice
  // already sent, and moving province must not rewrite old ones.
  const computed = calcSalesTax(subtotal, taxProfileOn(taxProfile, issuedDate));

  // An explicit map wins, for imported or historical invoices where what was
  // actually charged matters more than what today's rates would produce.
  // Legacy gstCollected/qstCollected are accepted too, so invoices imported
  // or written before the province table keep their original amounts.
  const explicit = input.taxCollected && typeof input.taxCollected === 'object'
    ? input.taxCollected
    : (input.gstCollected !== undefined || input.qstCollected !== undefined
        ? { GST: input.gstCollected, QST: input.qstCollected }
        : null);

  const taxCollected = explicit
    ? Object.fromEntries(
        Object.entries(explicit)
          .map(([k, v]) => [k, round2(Number(v) || 0)])
          .filter(([, v]) => v !== 0)
      )
    : computed.components;

  const taxTotal = sumTaxes(taxCollected);

  return {
    clientName,
    subtotal: round2(subtotal),
    taxCollected,
    taxTotal,
    total: round2(subtotal + taxTotal),
    issuedDate,
    dueDate,
    paidDate,
    notes: String(input.notes || '').trim()
  };
}

// Status is derived, never stored. Storing it means a "paid" flag and a
// paidDate that can disagree with each other, and an "overdue" flag that is
// wrong the morning after it is written.
export function statusOf(invoice, today) {
  requireIsoDate(today, 'today');
  if (invoice.paidDate) return 'paid';
  if (invoice.dueDate && invoice.dueDate < today) return 'overdue';
  return 'outstanding';
}

export function withStatus(invoice, today) {
  return { ...invoice, status: statusOf(invoice, today) };
}
