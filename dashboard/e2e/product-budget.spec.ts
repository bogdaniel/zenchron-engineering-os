import { expect, test } from '@playwright/test';
import { monthlyBudgetMetric } from '../src/productBudget';

type BudgetRun = NonNullable<Parameters<typeof monthlyBudgetMetric>[2]>[number];
const now = new Date('2026-11-28T15:00:00Z');
const run = (id: string, created_at: string, cost_usd?: number): BudgetRun => ({
  id, created_at, ...(cost_usd === undefined ? {} : { usage: { input_tokens: 10, output_tokens: 5, cost_usd } }),
});

test('budget sums only observed product runs created in this UTC month', () => {
  const ids = new Set(['first', 'second', 'old', 'future']);
  const runs = [
    run('first', '2026-11-01T00:00:00Z', 2.25),
    run('second', '2026-11-28T14:00:00Z', 1.15),
    run('old', '2026-10-31T23:59:59Z', 900),
    run('future', '2026-11-29T00:00:00Z', 700),
    run('other-product', '2026-11-20T00:00:00Z', 500),
  ];
  expect(monthlyBudgetMetric(7500, ids, runs, now)).toEqual([
    'Spent this month', '$3.40 of $75.00', 'budget, reporting only; cost on 2 of 2 runs',
  ]);
});

test('unknown provider costs count as unknown, not zero; a reported zero is still known', () => {
  const ids = new Set(['zero', 'unknown']);
  const runs = [run('zero', '2026-11-05T00:00:00Z', 0), run('unknown', '2026-11-10T00:00:00Z')];
  expect(monthlyBudgetMetric(7500, ids, runs, now)).toEqual([
    'Spent this month', 'at least $0.00 of $75.00',
    'budget, reporting only; cost on 1 of 2 runs, 1 unknown',
  ]);
  expect(monthlyBudgetMetric(7500, new Set(['unknown']), runs, now)[1]).toBe('Unknown of $75.00');
});

test('missing history or bounded-out run records cannot manufacture a complete zero', () => {
  expect(monthlyBudgetMetric(7500, undefined, [], now)).toEqual([
    'Spent this month', 'Unknown of $75.00', 'budget, reporting only; product run history unavailable',
  ]);
  expect(monthlyBudgetMetric(7500, new Set(['missing']), undefined, now)[1]).toBe('Unknown of $75.00');
  expect(monthlyBudgetMetric(7500, new Set(['missing']), [], now)).toEqual([
    'Spent this month', 'Unknown of $75.00',
    'budget, reporting only; no dated runs this month, 1 linked run record unavailable',
  ]);
  expect(monthlyBudgetMetric(7500, new Set(['known', 'missing']),
    [run('known', '2026-11-20T00:00:00Z', 4)], now)[1]).toBe('at least $4.00 of $75.00');
});

test('known empty month shows zero only with loaded history and run inventory', () => {
  expect(monthlyBudgetMetric(7500, new Set(), [], now)).toEqual([
    'Spent this month', '$0.00 of $75.00', 'budget, reporting only; no runs',
  ]);
});
