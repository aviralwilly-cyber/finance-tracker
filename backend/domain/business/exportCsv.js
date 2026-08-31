import { deductibleAmount } from './expenses.js';
import { recoverableTax, sumTaxes, taxesCollectedOn } from './salesTax.js';
import { statusOf } from './invoices.js';

// CSV for handing to an accountant.
//
// Pure string building — no Firestore, no Express, no file system. The point
// of this app is that its numbers can leave it; an app whose whole pitch is
// "take these to your accountant" with no export is a closed box.
//
// Every derived figure is included as its own column rather than left for the
// reader to recompute. An accountant should not have to reverse-engineer the
// meals cap from a percentage.

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  // Quote anything containing a delimiter, quote or newline; double internal
  // quotes. Without this, a client named "Acme, Inc." silently shifts every
  // column after it by one.
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(headers, rows) {
  return [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function invoicesToCsv(invoices, today) {
  const codes = [...new Set(invoices.flatMap(i => Object.keys(taxesCollectedOn(i))))].sort();
  const headers = [
    'Issued', 'Due', 'Paid', 'Status', 'Client', 'Notes',
    'Subtotal', ...codes.map(c => `${c} collected`), 'Sales tax total', 'Total'
  ];
  const rows = invoices.map(inv => {
    const taxes = taxesCollectedOn(inv);
    return [
      inv.issuedDate, inv.dueDate || '', inv.paidDate || '', statusOf(inv, today),
      inv.clientName, inv.notes || '',
      inv.subtotal,
      ...codes.map(c => taxes[c] ?? 0),
      sumTaxes(taxes),
      inv.total
    ];
  });
  return toCsv(headers, rows);
}

export function expensesToCsv(expenses, taxProfile) {
  const codes = [...new Set(expenses.flatMap(e => Object.keys(e.taxPaid || {})))].sort();
  const headers = [
    'Date', 'Description', 'Category', 'Amount (incl. tax)',
    ...codes.map(c => `${c} paid`),
    'Business use %', 'Deductible amount', 'Recoverable tax'
  ];
  const rows = expenses.map(e => [
    e.date, e.description || '', e.category || '',
    e.amount,
    ...codes.map(c => (e.taxPaid || {})[c] ?? 0),
    e.deductiblePercent ?? 100,
    deductibleAmount(e, taxProfile),
    recoverableTax(e, taxProfile)
  ]);
  return toCsv(headers, rows);
}
