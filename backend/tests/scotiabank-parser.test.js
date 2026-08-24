import { describe, it, expect } from 'vitest';
import { isScotiabankDayToDayStatement, parseScotiabankDayToDayStatement } from '../lib.js';

// All data below is synthetic — fake names, fake numbers, structured to
// match the real statement format without ever touching real account data.

describe('isScotiabankDayToDayStatement', () => {
  it('matches text containing the internal reference code and transaction table headers', () => {
    const text = `SBSAV16000_5640330_001
Amounts Amounts
Date Transactions withdrawn ($) deposited ($) Balance ($)`;
    expect(isScotiabankDayToDayStatement(text)).toBe(true);
  });

  it('matches via the support phone number as an alternate signal', () => {
    const text = `Call 1 800 4-SCOTIA
Amounts Amounts
Date Transactions withdrawn ($) deposited ($) Balance ($)`;
    expect(isScotiabankDayToDayStatement(text)).toBe(true);
  });

  it('does not match plain unrelated text', () => {
    expect(isScotiabankDayToDayStatement('Just some random PDF text with no markers.')).toBe(false);
  });

  it('does not match Scotiabank markers alone without the transaction table headers', () => {
    // Regression guard: catches statements from other Scotiabank products
    // that aren't actually this specific layout.
    expect(isScotiabankDayToDayStatement('SBSAV16000_5640330_001 with no table headers here')).toBe(false);
  });
});

describe('parseScotiabankDayToDayStatement', () => {
  const sampleText = `Amounts Amounts
Date Transactions withdrawn ($) deposited ($) Balance ($)
SBSAV16000_5640330_001
Questions?
Call 1 800 4-SCOTIA
(1 800 472-6842)
Opening Balance on May 1, 2026 100.00
May 1 Opening Balance 100.00
May 2 Point of sale purchase 20.00 80.00
Test Store A
May 3 Deposit 50.00 130.00
Some Deposit Source
May 4 Point of sale purchase 30.00 100.00
Test Store B
May 5 Payroll dep. 200.00 300.00
Employer Inc
May 6 MB-Transfer to 50.00 250.00
Credit Card
May 6 Closing Balance 250.00`;

  it('extracts the correct number of real transactions, excluding balance-only lines', () => {
    const result = parseScotiabankDayToDayStatement(sampleText);
    expect(result.length).toBe(5); // Opening/Closing Balance lines are not transactions
  });

  it('classifies debit vs. credit by comparing to the running balance, not by guessing', () => {
    const result = parseScotiabankDayToDayStatement(sampleText);
    expect(result[0]).toMatchObject({ description: expect.stringContaining('Point of sale purchase'), amount: 20, type: 'debit' });
    expect(result[1]).toMatchObject({ description: expect.stringContaining('Deposit'), amount: 50, type: 'credit' });
    expect(result[3]).toMatchObject({ description: expect.stringContaining('Payroll dep.'), amount: 200, type: 'credit' });
    expect(result[4]).toMatchObject({ description: expect.stringContaining('MB-Transfer to'), amount: 50, type: 'debit' });
  });

  it('merges a continuation line (merchant detail) into the transaction above it', () => {
    const result = parseScotiabankDayToDayStatement(sampleText);
    expect(result[0].description).toContain('Test Store A');
    expect(result[2].description).toContain('Test Store B');
  });

  it('assigns the correct dates, inferring the year from the statement header', () => {
    const result = parseScotiabankDayToDayStatement(sampleText);
    expect(result[0].date).toBe('2026-05-02');
    expect(result[4].date).toBe('2026-05-06');
  });

  it('produces no NaN amounts', () => {
    const result = parseScotiabankDayToDayStatement(sampleText);
    expect(result.some(t => Number.isNaN(t.amount))).toBe(false);
  });

  it('rolls the year forward when the statement crosses a year boundary', () => {
    const crossYearText = `Amounts Amounts
Date Transactions withdrawn ($) deposited ($) Balance ($)
SBSAV16000_5640330_001
Opening Balance on Dec 15, 2026 100.00
Dec 15 Opening Balance 100.00
Dec 20 Point of sale purchase 10.00 90.00
Test Store
Jan 3 Point of sale purchase 5.00 85.00
Test Store`;
    const result = parseScotiabankDayToDayStatement(crossYearText);
    expect(result[0].date).toBe('2026-12-20');
    expect(result[1].date).toBe('2027-01-03'); // year rolled over
  });

  it('returns an empty array for text with no recognizable transaction lines', () => {
    expect(parseScotiabankDayToDayStatement('Nothing useful here.')).toEqual([]);
  });
});
