import { round2 } from './deductions.js';

// Money invoiced but not collected, bucketed by how overdue it is.
//
// For a freelancer this is often more urgent than profit: you can have a
// good month on paper and still not make rent, because the revenue is
// sitting in someone else's accounts payable. Nothing in the personal app
// has an equivalent concept.

export const AGING_BUCKETS = [
  { id: 'current', label: 'Not yet due', maxDaysOverdue: 0 },
  { id: 'd1_30', label: '1–30 days', maxDaysOverdue: 30 },
  { id: 'd31_60', label: '31–60 days', maxDaysOverdue: 60 },
  { id: 'd61_90', label: '61–90 days', maxDaysOverdue: 90 },
  { id: 'd90_plus', label: 'Over 90 days', maxDaysOverdue: Infinity }
];

function daysBetween(fromDate, toDate) {
  const ms = new Date(toDate) - new Date(fromDate);
  return Math.floor(ms / 86400000);
}

function bucketFor(daysOverdue) {
  if (daysOverdue <= 0) return 'current';
  return AGING_BUCKETS.find(b => daysOverdue <= b.maxDaysOverdue).id;
}

// Outstanding means paidDate is null, regardless of basis — an unpaid
// invoice is a receivable whether the books are kept on cash or accrual.
export function receivablesAging(revenues, today) {
  const outstanding = revenues.filter(r => !r.paidDate);

  const buckets = Object.fromEntries(
    AGING_BUCKETS.map(b => [b.id, { label: b.label, total: 0, count: 0 }])
  );

  let total = 0;
  let overdue = 0;

  for (const invoice of outstanding) {
    // An invoice with no due date is treated as not yet due rather than
    // instantly overdue — the alternative flags every draft as late.
    const daysOverdue = invoice.dueDate ? daysBetween(invoice.dueDate, today) : 0;
    // `total` is stored at issue time. Falls back to the old field pair for
    // invoices written before the province table existed.
    const amount = invoice.total !== undefined
      ? (Number(invoice.total) || 0)
      : (Number(invoice.subtotal) || 0)
        + (Number(invoice.gstCollected) || 0)
        + (Number(invoice.qstCollected) || 0);

    const bucket = buckets[bucketFor(daysOverdue)];
    bucket.total = round2(bucket.total + amount);
    bucket.count += 1;

    total = round2(total + amount);
    if (daysOverdue > 0) overdue = round2(overdue + amount);
  }

  return { total, overdue, count: outstanding.length, buckets };
}
