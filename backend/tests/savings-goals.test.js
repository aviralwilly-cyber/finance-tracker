import { describe, it, expect } from 'vitest';
import { monthsBetween, goalProgress } from '../lib.js';

const TODAY = '2026-08-27';

describe('monthsBetween', () => {
  it('counts whole months', () => {
    expect(monthsBetween('2026-01-01', '2026-03-01')).toBe(2);
  });

  it('does not count a month that has not fully elapsed', () => {
    // Jan 15 → Mar 10 is one full month plus a partial, not two.
    expect(monthsBetween('2026-01-15', '2026-03-10')).toBe(1);
  });

  it('handles year boundaries', () => {
    expect(monthsBetween('2026-11-01', '2027-02-01')).toBe(3);
  });

  it('returns negative for a date in the past', () => {
    expect(monthsBetween('2026-08-01', '2026-05-01')).toBe(-3);
  });

  it('returns 0 for the same date', () => {
    expect(monthsBetween('2026-08-27', '2026-08-27')).toBe(0);
  });
});

describe('goalProgress', () => {
  it('computes remaining and percent from the allocated balance', () => {
    const r = goalProgress({ targetAmount: 1000, allocated: 250 }, TODAY);
    expect(r.remaining).toBe(750);
    expect(r.percent).toBe(25);
    expect(r.complete).toBe(false);
  });

  it('marks a goal complete once allocated meets the target', () => {
    const r = goalProgress({ targetAmount: 500, allocated: 500 }, TODAY);
    expect(r.complete).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('caps percent at 100 when over-funded rather than reporting 120%', () => {
    const r = goalProgress({ targetAmount: 500, allocated: 600 }, TODAY);
    expect(r.percent).toBe(100);
    expect(r.remaining).toBe(0);
  });

  it('divides the remainder across the months left', () => {
    const r = goalProgress(
      { targetAmount: 1800, allocated: 600, targetDate: '2026-12-01' },
      TODAY
    );
    expect(r.monthsLeft).toBe(3);
    expect(r.requiredPerMonth).toBe(400); // 1200 / 3
  });

  it('treats a deadline this month as needing the full remainder now, not a divide by zero', () => {
    const r = goalProgress(
      { targetAmount: 300, allocated: 100, targetDate: '2026-08-30' },
      TODAY
    );
    expect(r.requiredPerMonth).toBe(200);
    expect(Number.isFinite(r.requiredPerMonth)).toBe(true);
  });

  it('flags an unmet goal whose date has passed as overdue', () => {
    const r = goalProgress(
      { targetAmount: 500, allocated: 100, targetDate: '2026-01-01' },
      TODAY
    );
    expect(r.overdue).toBe(true);
    expect(r.requiredPerMonth).toBeNull();
  });

  it('does not flag a COMPLETED goal as overdue even if the date passed', () => {
    const r = goalProgress(
      { targetAmount: 500, allocated: 500, targetDate: '2026-01-01' },
      TODAY
    );
    expect(r.complete).toBe(true);
    expect(r.overdue).toBe(false);
  });

  it('compares the required rate against actual saving to judge on-track', () => {
    const goal = { targetAmount: 1800, allocated: 600, targetDate: '2026-12-01' };
    expect(goalProgress(goal, TODAY, 500).onTrack).toBe(true);   // needs 400
    expect(goalProgress(goal, TODAY, 180).onTrack).toBe(false);
  });

  it('leaves onTrack null when the actual saving rate is unknown', () => {
    const r = goalProgress(
      { targetAmount: 1000, allocated: 0, targetDate: '2026-12-01' },
      TODAY
    );
    expect(r.onTrack).toBeNull();
  });

  it('handles a goal with no target date — progress only, no schedule', () => {
    const r = goalProgress({ targetAmount: 1000, allocated: 400 }, TODAY);
    expect(r.percent).toBe(40);
    expect(r.monthsLeft).toBeNull();
    expect(r.requiredPerMonth).toBeNull();
  });

  it('does not divide by zero for a zero-target goal', () => {
    const r = goalProgress({ targetAmount: 0, allocated: 0 }, TODAY);
    expect(r.percent).toBe(0);
    expect(Number.isNaN(r.percent)).toBe(false);
  });
});
