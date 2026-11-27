import type { AgentRun } from './agentsData';

/**
 * One delivery-metric row: a product's reporting-only monthly budget against the provider-reported cost of its
 * WorkGraph runs started this calendar month (UTC). Runs whose provider reported no cost count as unknown, never zero.
 */
export function monthlyBudgetMetric(budgetCents: number | undefined, productRunIDs: Set<string>,
  runs: AgentRun[] | undefined, now: Date): [string, string, string] {
  const budget = budgetCents ? ` of $${(budgetCents / 100).toFixed(2)}` : '';
  const scope = budgetCents ? 'budget, reporting only' : 'no budget set';
  if (!runs) return ['Spent this month', `Unknown${budget}`, `${scope}; run records unavailable`];
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthRuns = runs.filter((run) => productRunIDs.has(run.id) && Date.parse(run.created_at) >= monthStart);
  const costs = monthRuns.flatMap((run) => run.usage?.cost_usd === undefined ? [] : [run.usage.cost_usd]);
  const unknown = monthRuns.length - costs.length;
  const spent = costs.length || !monthRuns.length ? `$${costs.reduce((sum, cost) => sum + cost, 0).toFixed(2)}` : 'Unknown';
  const coverage = !monthRuns.length ? 'no runs'
    : `cost on ${costs.length} of ${monthRuns.length} runs${unknown ? `, ${unknown} unknown` : ''}`;
  return ['Spent this month', `${spent}${budget}`, `${scope}; ${coverage}`];
}
