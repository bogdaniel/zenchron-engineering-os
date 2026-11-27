import type { AgentRun } from './agentsData';

type BudgetRun = Pick<AgentRun, 'id' | 'created_at' | 'usage'>;

/**
 * Reporting-only monthly budget and provider-reported spend from product WorkGraph runs (UTC).
 * Missing product history, absent run records, and unknown provider costs must not appear as complete $0 spend.
 */
export function monthlyBudgetMetric(budgetCents: number | undefined, productRunIDs: Set<string> | undefined,
  runs: BudgetRun[] | undefined, now: Date): [string, string, string] {
  const budget = budgetCents ? ` of $${(budgetCents / 100).toFixed(2)}` : '';
  const scope = budgetCents ? 'budget, reporting only' : 'no budget set';
  if (!productRunIDs) return ['Spent this month', `Unknown${budget}`, `${scope}; product run history unavailable`];
  if (!runs) return ['Spent this month', `Unknown${budget}`, `${scope}; run records unavailable`];

  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const knownIDs = new Set(runs.map((run) => run.id));
  const missingRecords = [...productRunIDs].filter((id) => !knownIDs.has(id)).length;
  // A run starting in an earlier month (or in the future) cannot be counted as observed current-month spend.
  const monthRuns = runs.filter((run) => {
    const created = Date.parse(run.created_at);
    return productRunIDs.has(run.id) && created >= monthStart && created <= now.getTime();
  });
  const costs = monthRuns.flatMap((run) => run.usage?.cost_usd === undefined ? [] : [run.usage.cost_usd]);
  const unknownCosts = monthRuns.length - costs.length;
  const partial = unknownCosts > 0 || missingRecords > 0;
  const spent = costs.length
    ? `${partial ? 'at least ' : ''}$${costs.reduce((sum, cost) => sum + cost, 0).toFixed(2)}`
    : monthRuns.length || missingRecords ? 'Unknown' : '$0.00';
  const coverage = monthRuns.length
    ? `cost on ${costs.length} of ${monthRuns.length} runs${unknownCosts ? `, ${unknownCosts} unknown` : ''}`
    : missingRecords ? 'no dated runs this month' : 'no runs';
  const missing = missingRecords
    ? `, ${missingRecords} linked run record${missingRecords === 1 ? '' : 's'} unavailable` : '';
  return ['Spent this month', `${spent}${budget}`, `${scope}; ${coverage}${missing}`];
}
