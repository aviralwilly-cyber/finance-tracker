import { describe, it, expect } from 'vitest';
import {
  toMonthlyAmount,
  incomeInEffectOn,
  lastNMonths,
  daysLeftInMonth,
  advanceDate,
  categoriesFor
} from '../lib.js';

describe('toMonthlyAmount', () => {
  it('passes monthly amounts through unchanged', () => {
    expect(toMonthlyAmount(4500, 'monthly')).toBe(4500);
  });

  it('converts biweekly to a monthly equivalent using 26 pay periods/year', () => {
    // $1000 biweekly = 26 paychecks/year = $26,000/year = $2166.67/month
    expect(toMonthlyAmount(1000, 'biweekly')).toBeCloseTo(2166.6667, 3);
  });

  it('handles zero income', () => {
    expect(toMonthlyAmount(0, 'monthly')).toBe(0);
    expect(toMonthlyAmount(0, 'biweekly')).toBe(0);
  });
});

describe('incomeInEffectOn', () => {
  const entries = [
    { amount: 4000, frequency: 'monthly', effectiveDate: '2026-01-01' },
    { amount: 4500, frequency: 'monthly', effectiveDate: '2026-06-01' },
    { amount: 5000, frequency: 'monthly', effectiveDate: '2026-09-01' }
  ];

  it('picks the most recent entry on or before the target date', () => {
    expect(incomeInEffectOn(entries, '2026-07-15').amount).toBe(4500);
  });

  it('does not let a future raise affect a past date — history stays accurate', () => {
    expect(incomeInEffectOn(entries, '2026-03-01').amount).toBe(4000);
  });

  it('picks the exact entry when the target date matches effectiveDate exactly', () => {
    expect(incomeInEffectOn(entries, '2026-09-01').amount).toBe(5000);
  });

  it('returns null when the target date is before any entry existed', () => {
    expect(incomeInEffectOn(entries, '2025-01-01')).toBeNull();
  });

  it('returns null for an empty income history', () => {
    expect(incomeInEffectOn([], '2026-01-01')).toBeNull();
  });

  it('picks the latest raise when the target date is after all entries', () => {
    expect(incomeInEffectOn(entries, '2027-01-01').amount).toBe(5000);
  });
});

describe('lastNMonths', () => {
  it('returns the requested count, oldest first, ending at the reference month', () => {
    const months = lastNMonths(3, new Date('2026-08-15'));
    expect(months.map(m => m.month)).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('computes the correct last day for each month, including a leap February', () => {
    const months = lastNMonths(2, new Date('2028-02-10')); // 2028 is a leap year
    expect(months).toEqual([
      { month: '2028-01', lastDay: '2028-01-31' },
      { month: '2028-02', lastDay: '2028-02-29' }
    ]);
  });

  it('handles a non-leap February correctly', () => {
    const months = lastNMonths(1, new Date('2026-02-10'));
    expect(months[0].lastDay).toBe('2026-02-28');
  });

  it('rolls across a year boundary correctly', () => {
    const months = lastNMonths(3, new Date('2026-01-15'));
    expect(months.map(m => m.month)).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});

describe('daysLeftInMonth', () => {
  it('counts remaining days correctly mid-month', () => {
    expect(daysLeftInMonth('2026-08-24')).toBe(7); // August has 31 days
  });

  it('returns 0 on the last day of the month', () => {
    expect(daysLeftInMonth('2026-08-31')).toBe(0);
  });

  it('handles February correctly in a non-leap year', () => {
    expect(daysLeftInMonth('2026-02-01')).toBe(27); // 28 - 1
  });
});

describe('advanceDate — recurring transaction scheduling', () => {
  it('advances weekly by exactly 7 days', () => {
    expect(advanceDate('2026-06-01', 'weekly')).toBe('2026-06-08');
  });

  it('advances biweekly by exactly 14 days', () => {
    expect(advanceDate('2026-06-01', 'biweekly')).toBe('2026-06-15');
  });

  it('advances monthly on a normal day-of-month', () => {
    expect(advanceDate('2026-06-15', 'monthly')).toBe('2026-07-15');
  });

  // This is the case that was actually broken before this fix: JavaScript's
  // Date.setMonth() silently overflows into the following month for a day
  // that doesn't exist in the target month (e.g. "Feb 31" doesn't exist),
  // which meant a recurring transaction set for the 31st could skip
  // February entirely and land in March instead.
  it('clamps to the last valid day of the month instead of overflowing (Jan 31 -> Feb 28)', () => {
    expect(advanceDate('2026-01-31', 'monthly')).toBe('2026-02-28');
  });

  it('clamps correctly into a leap February (Jan 31 -> Feb 29)', () => {
    expect(advanceDate('2028-01-31', 'monthly')).toBe('2028-02-29');
  });

  it('clamps a 31-day month rolling into a 30-day month (Mar 31 -> Apr 30)', () => {
    expect(advanceDate('2026-03-31', 'monthly')).toBe('2026-04-30');
  });

  it('rolls the year over correctly for a December-to-January advance', () => {
    expect(advanceDate('2026-12-31', 'monthly')).toBe('2027-01-31');
  });

  it('does not clamp when the day-of-month is valid in the target month', () => {
    // Regression guard: the clamping logic must not affect ordinary dates.
    expect(advanceDate('2026-05-15', 'monthly')).toBe('2026-06-15');
  });
});

describe('categoriesFor', () => {
  it('returns the personal category set for "self"', () => {
    expect(categoriesFor('self')).toContain('Groceries');
    expect(categoriesFor('self')).toContain('Rent/Housing');
  });

  it('returns the business category set for "business"', () => {
    expect(categoriesFor('business')).toContain('Client Meals');
    expect(categoriesFor('business')).not.toContain('Groceries');
  });

  it('falls back to the personal set for an unrecognized purpose', () => {
    expect(categoriesFor('nonsense')).toEqual(categoriesFor('self'));
  });

  it('appends custom categories on top of the preset list', () => {
    const result = categoriesFor('self', ['Pet Care']);
    expect(result).toContain('Pet Care');
    expect(result).toContain('Groceries'); // presets stay intact
  });

  it('deduplicates a custom category that matches a preset, case-insensitively', () => {
    const result = categoriesFor('self', ['groceries', 'Pet Care']);
    const matches = result.filter(c => c.toLowerCase() === 'groceries');
    expect(matches.length).toBe(1); // not duplicated
    expect(result).toContain('Pet Care');
  });
});
