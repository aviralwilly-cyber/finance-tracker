import { describe, it, expect } from 'vitest';
import { normalizeMerchant, detectRecurringBills } from '../lib.js';

const TODAY = '2026-08-26';

// Helper — most tests only care about date/description/amount.
const tx = (date, description, amount, extra = {}) => ({
  date, description, amount, category: 'Other', ...extra
});

describe('normalizeMerchant', () => {
  it('strips reference numbers so the same merchant groups together', () => {
    expect(normalizeMerchant('NETFLIX.COM 8668396')).toBe(normalizeMerchant('NETFLIX.COM 8661234'));
  });

  it('strips store numbers', () => {
    expect(normalizeMerchant('STARBUCKS #2917')).toBe(normalizeMerchant('STARBUCKS #4051'));
  });

  it('strips corporate suffixes and punctuation', () => {
    expect(normalizeMerchant('Acme Corp.')).toBe('acme');
    expect(normalizeMerchant('ACME INC')).toBe('acme');
  });

  it('keeps genuinely different merchants distinct', () => {
    expect(normalizeMerchant('NETFLIX')).not.toBe(normalizeMerchant('SPOTIFY'));
  });

  it('handles empty or missing input without throwing', () => {
    expect(normalizeMerchant('')).toBe('');
    expect(normalizeMerchant(undefined)).toBe('');
  });
});

describe('detectRecurringBills', () => {
  it('detects a monthly subscription despite varying reference numbers', () => {
    const transactions = [
      tx('2026-05-03', 'NETFLIX.COM 8668396', 16.49),
      tx('2026-06-03', 'NETFLIX.COM 8661234', 16.49),
      tx('2026-07-03', 'NETFLIX.COM 8669876', 16.49),
      tx('2026-08-03', 'NETFLIX.COM 8665555', 16.49)
    ];
    const [found] = detectRecurringBills(transactions, [], TODAY);
    expect(found).toMatchObject({ amount: 16.49, frequency: 'monthly', occurrences: 4 });
  });

  it('tolerates amounts that vary within 15% — utility bills are not fixed', () => {
    const transactions = [
      tx('2026-06-15', 'HYDRO ONE', 110),
      tx('2026-07-15', 'HYDRO ONE', 118),
      tx('2026-08-15', 'HYDRO ONE', 105)
    ];
    expect(detectRecurringBills(transactions, [], TODAY)).toHaveLength(1);
  });

  it('rejects amounts that vary too much to be the same bill', () => {
    const transactions = [
      tx('2026-06-15', 'SOME SHOP', 20),
      tx('2026-07-15', 'SOME SHOP', 200),
      tx('2026-08-15', 'SOME SHOP', 65)
    ];
    expect(detectRecurringBills(transactions, [], TODAY)).toHaveLength(0);
  });

  // The most important negative case: frequent purchases at one merchant
  // look superficially like a subscription. Even spacing is what separates
  // a bill from a habit.
  it('rejects a frequent-but-irregular merchant (coffee, not a subscription)', () => {
    const transactions = [
      tx('2026-08-02', 'STARBUCKS #123', 5.75),
      tx('2026-08-04', 'STARBUCKS #456', 5.50),
      tx('2026-08-19', 'STARBUCKS #789', 5.75)
    ];
    expect(detectRecurringBills(transactions, [], TODAY)).toHaveLength(0);
  });

  it('requires at least three occurrences — two could be coincidence', () => {
    const transactions = [
      tx('2026-07-10', 'SPOTIFY', 10.99),
      tx('2026-08-10', 'SPOTIFY', 10.99)
    ];
    expect(detectRecurringBills(transactions, [], TODAY)).toHaveLength(0);
  });

  it('detects weekly and biweekly cadences, not just monthly', () => {
    const weekly = [
      tx('2026-08-01', 'GYM CLASS', 25),
      tx('2026-08-08', 'GYM CLASS', 25),
      tx('2026-08-15', 'GYM CLASS', 25)
    ];
    expect(detectRecurringBills(weekly, [], TODAY)[0].frequency).toBe('weekly');

    const biweekly = [
      tx('2026-06-05', 'CLEANER', 80),
      tx('2026-06-19', 'CLEANER', 80),
      tx('2026-07-03', 'CLEANER', 80)
    ];
    expect(detectRecurringBills(biweekly, [], TODAY)[0].frequency).toBe('biweekly');
  });

  it('ignores a cadence it cannot represent (quarterly)', () => {
    const transactions = [
      tx('2026-02-01', 'QUARTERLY FEE', 90),
      tx('2026-05-01', 'QUARTERLY FEE', 90),
      tx('2026-08-01', 'QUARTERLY FEE', 90)
    ];
    // ~90 day gaps don't map to weekly/biweekly/monthly, so no guess is made.
    expect(detectRecurringBills(transactions, [], TODAY)).toHaveLength(0);
  });

  it('never flags credits — income is not a bill', () => {
    const transactions = [
      tx('2026-06-01', 'PAYROLL DEP', 2000, { type: 'credit' }),
      tx('2026-07-01', 'PAYROLL DEP', 2000, { type: 'credit' }),
      tx('2026-08-01', 'PAYROLL DEP', 2000, { type: 'credit' })
    ];
    expect(detectRecurringBills(transactions, [], TODAY)).toHaveLength(0);
  });

  it('suppresses bills the user already tracks, matching loosely on merchant', () => {
    const transactions = [
      tx('2026-06-01', 'RENT PAYMENT', 2100),
      tx('2026-07-01', 'RENT PAYMENT', 2100),
      tx('2026-08-01', 'RENT PAYMENT', 2100)
    ];
    expect(detectRecurringBills(transactions, [], TODAY)).toHaveLength(1);
    // Different casing/wording, same normalized merchant.
    expect(detectRecurringBills(transactions, [{ description: 'Rent payment' }], TODAY)).toHaveLength(0);
  });

  it('projects a next due date in the future, not the past', () => {
    const transactions = [
      tx('2026-01-05', 'OLD SUB', 12),
      tx('2026-02-05', 'OLD SUB', 12),
      tx('2026-03-05', 'OLD SUB', 12)
    ];
    const [found] = detectRecurringBills(transactions, [], TODAY);
    expect(found.nextDueDate >= TODAY).toBe(true);
  });

  it('sorts the largest bills first', () => {
    const transactions = [
      tx('2026-06-03', 'SMALL SUB', 5), tx('2026-07-03', 'SMALL SUB', 5), tx('2026-08-03', 'SMALL SUB', 5),
      tx('2026-06-01', 'BIG RENT', 2100), tx('2026-07-01', 'BIG RENT', 2100), tx('2026-08-01', 'BIG RENT', 2100)
    ];
    const found = detectRecurringBills(transactions, [], TODAY);
    expect(found[0].description).toBe('BIG RENT');
  });

  it('includes the evidence behind each suggestion', () => {
    const transactions = [
      tx('2026-06-03', 'NETFLIX', 16.49),
      tx('2026-07-03', 'NETFLIX', 16.49),
      tx('2026-08-03', 'NETFLIX', 16.49)
    ];
    const [found] = detectRecurringBills(transactions, [], TODAY);
    expect(found.occurrences).toBe(3);
    expect(found.sampleDates).toEqual(['2026-06-03', '2026-07-03', '2026-08-03']);
    expect(found.totalSpent).toBeCloseTo(49.47, 2);
    expect(found.firstSeen).toBe('2026-06-03');
  });

  it('returns an empty array for an empty history', () => {
    expect(detectRecurringBills([], [], TODAY)).toEqual([]);
  });
});
