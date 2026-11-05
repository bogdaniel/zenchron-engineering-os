import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { Project } from './projects';

const pullRequestHistorySchema = z.object({
  complete: z.boolean(),
  items: z.array(z.object({
    created_at: z.string(), closed_at: z.string().nullable(), merged_at: z.string().nullable(),
  })),
});
type TimeRange = '30d' | '90d' | '365d' | 'all';
const rangeDurations: Record<Exclude<TimeRange, 'all'>, number> = {
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  '365d': 365 * 24 * 60 * 60 * 1000,
};
const days = 24 * 60 * 60 * 1000;
const outcomeColors = { merged: '#40d9a3', closed: '#fa668b', open: '#b177ff' };

function inRange(timestamp: string, range: TimeRange, now = Date.now()) {
  const date = Date.parse(timestamp);
  return Number.isFinite(date) && date <= now && (range === 'all' || date >= now - rangeDurations[range]);
}

function pullRequestTrend(items: z.infer<typeof pullRequestHistorySchema>['items'], range: TimeRange, now = Date.now()) {
  const earliest = items.flatMap((item) => item.merged_at ? [Date.parse(item.merged_at)] : [])
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= now);
  const span = range === 'all'
    ? Math.max(7 * days, now - (earliest.length ? Math.min(...earliest) : now - 365 * days))
    : rangeDurations[range];
  const bucketCount = range === '30d' ? 5 : range === '90d' ? 7 : 12;
  const start = now - span;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    date: new Date(start + index * span / bucketCount).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    merged: 0,
    closed: 0,
    accepted: 0,
    cycleHours: 0,
    cycles: 0,
  }));
  const bucketIndex = (timestamp: number) => Math.min(bucketCount - 1, Math.floor((timestamp - start) / span * bucketCount));
  for (const item of items) {
    if (item.closed_at) {
      const closedAt = Date.parse(item.closed_at);
      if (Number.isFinite(closedAt) && closedAt >= start && closedAt <= now) {
        const index = bucketIndex(closedAt);
        buckets[index].closed++;
        if (item.merged_at && Date.parse(item.merged_at) <= now) buckets[index].accepted++;
      }
    }
    if (!item.merged_at) continue;
    const mergedAt = Date.parse(item.merged_at);
    const createdAt = Date.parse(item.created_at);
    if (!Number.isFinite(mergedAt) || mergedAt < start || mergedAt > now) continue;
    const index = bucketIndex(mergedAt);
    buckets[index].merged++;
    if (Number.isFinite(createdAt) && createdAt <= mergedAt) {
      buckets[index].cycleHours += (mergedAt - createdAt) / 3_600_000;
      buckets[index].cycles++;
    }
  }
  return buckets.map(({ cycleHours, cycles, closed, accepted, ...bucket }) => ({
    ...bucket, cycle: cycles ? Math.round(cycleHours / cycles * 10) / 10 : null,
    acceptance: closed ? Math.round(accepted / closed * 100) : null,
  }));
}

export function useReportPullRequestMetrics(projects: Project[] | undefined, range: TimeRange) {
  const githubProjects = [...new Map((projects ?? [])
    .filter((project) => project.git_remote.startsWith('github.com/'))
    .map((project) => [project.git_remote, project])).values()];
  const configuredRemoteCount = new Set(projects?.flatMap((project) => project.git_remote ? [project.git_remote] : []) ?? []).size;
  const since = useMemo(() => range === 'all' ? '' :
    new Date(Date.now() - rangeDurations[range]).toISOString(), [range]);
  const history = useQuery({
    queryKey: ['report-pull-request-history', githubProjects.map((project) => project.id), since],
    enabled: githubProjects.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const histories = await Promise.all(githubProjects.map(async (project) => {
        const query = since ? `?since=${encodeURIComponent(since)}` : '';
        const response = await fetch(`/api/v1/projects/${project.id}/pull-request-history${query}`);
        if (!response.ok) throw new Error(`GitHub PR history unavailable (${response.status})`);
        return pullRequestHistorySchema.parse(await response.json());
      }));
      return { items: histories.flatMap((result) => result.items), complete: histories.every((result) => result.complete) };
    },
  });
  const complete = githubProjects.length > 0 && history.isSuccess && history.data.complete;
  const items = history.data?.items ?? [];
  const outcomes = [
    {
      name: 'Merged',
      value: items.filter((item) => item.merged_at && inRange(item.merged_at, range)).length,
      color: outcomeColors.merged,
    },
    {
      name: 'Closed unmerged',
      value: items.filter((item) => item.closed_at && !item.merged_at && inRange(item.closed_at, range)).length,
      color: outcomeColors.closed,
    },
    {
      name: 'Open',
      value: items.filter((item) => !item.closed_at && inRange(item.created_at, range)).length,
      color: outcomeColors.open,
    },
  ];
  const merged = items.filter((item) => item.merged_at && inRange(item.merged_at, range));
  const closed = items.filter((item) => item.closed_at && inRange(item.closed_at, range));
  const cycleTimes = merged.flatMap((pull) => {
    const created = Date.parse(pull.created_at);
    const mergedAt = Date.parse(pull.merged_at!);
    return Number.isFinite(created) && created <= mergedAt ? [(mergedAt - created) / 3_600_000] : [];
  });
  const cycleTime = cycleTimes.length
    ? Math.round(cycleTimes.reduce((total, value) => total + value, 0) / cycleTimes.length * 10) / 10
    : undefined;
  const spanDays = range === 'all'
    ? Math.max(7, (Date.now() - Math.min(...merged.map((pull) => Date.parse(pull.merged_at!)))) / days)
    : rangeDurations[range] / days;
  return {
    ...history,
    githubProjectCount: githubProjects.length,
    configuredRemoteCount,
    unsupportedRemoteCount: Math.max(0, configuredRemoteCount - githubProjects.length),
    unconfiguredCheckoutCount: projects?.filter((project) => !project.git_remote).length ?? 0,
    complete,
    mergedCount: merged.length,
    outcomes,
    deliveryVelocity: complete ? Math.round(merged.length / spanDays * 7 * 10) / 10 : undefined,
    cycleTime: complete ? cycleTime : undefined,
    acceptanceRate: complete && closed.length ? Math.round(merged.length / closed.length * 100) : undefined,
    trend: pullRequestTrend(items, range),
  };
}
