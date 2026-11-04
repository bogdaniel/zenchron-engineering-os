import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { Project } from './projects';

const workflowRunHistorySchema = z.object({
  complete: z.boolean(),
  items: z.array(z.object({
    created_at: z.string(), status: z.string(), run_started_at: z.string().nullable(), updated_at: z.string(),
  })),
});
type TimeRange = '30d' | '90d' | '365d' | 'all';
const rangeDurations: Record<Exclude<TimeRange, 'all'>, number> = {
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  '365d': 365 * 24 * 60 * 60 * 1000,
};
const durationBuckets = [
  { label: '<2', max: 2 }, { label: '2–4', max: 4 }, { label: '4–6', max: 6 },
  { label: '6–8', max: 8 }, { label: '8–10', max: 10 }, { label: '10–15', max: 15 },
  { label: '15–20', max: 20 }, { label: '20–30', max: 30 }, { label: '>30', max: Infinity },
];

export function useReportWorkflowRunMetrics(projects: Project[] | undefined, range: TimeRange) {
  const githubProjects = [...new Map((projects ?? [])
    .filter((project) => project.git_remote.startsWith('github.com/'))
    .map((project) => [project.git_remote, project])).values()];
  const since = useMemo(() => range === 'all' ? '' :
    new Date(Date.now() - rangeDurations[range]).toISOString(), [range]);
  const history = useQuery({
    queryKey: ['report-workflow-run-history', githubProjects.map((project) => project.id), since],
    enabled: githubProjects.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const histories = await Promise.all(githubProjects.map(async (project) => {
        const query = since ? `?since=${encodeURIComponent(since)}` : '';
        const response = await fetch(`/api/v1/projects/${project.id}/workflow-run-history${query}`);
        if (!response.ok) throw new Error(`GitHub workflow-run history unavailable (${response.status})`);
        return workflowRunHistorySchema.parse(await response.json());
      }));
      return { items: histories.flatMap((result) => result.items), complete: histories.every((result) => result.complete) };
    },
  });
  const complete = githubProjects.length > 0 && history.isSuccess && history.data.complete;
  const now = Date.now();
  const samples = (history.data?.items ?? []).flatMap((run) => {
    if (run.status !== 'completed' || !run.run_started_at) return [];
    const created = Date.parse(run.created_at);
    const start = Date.parse(run.run_started_at);
    const end = Date.parse(run.updated_at);
    if (!Number.isFinite(created) || created > now || !Number.isFinite(start) || !Number.isFinite(end) ||
      start > end || end > now || (range !== 'all' && created < now - rangeDurations[range])) return [];
    return [{ created, duration: (end - start) / 60_000 }];
  });
  const durations = samples.map((sample) => sample.duration);
  const averageMinutes = complete && durations.length
    ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length * 10) / 10
    : undefined;
  const distribution = durationBuckets.map((bucket, index) => ({
    duration: bucket.label,
    runs: durations.filter((duration) => duration >= (index ? durationBuckets[index - 1].max : 0) &&
      duration < bucket.max).length,
  }));
  const bucketCount = range === '30d' ? 5 : range === '90d' ? 7 : 12;
  const earliest = samples.length ? Math.min(...samples.map((sample) => sample.created)) : now - 365 * 24 * 60 * 60 * 1000;
  const span = range === 'all' ? Math.max(7 * 24 * 60 * 60 * 1000, now - earliest) : rangeDurations[range];
  const trendStart = now - span;
  const trendBuckets = Array.from({ length: bucketCount }, () => ({ total: 0, count: 0 }));
  for (const sample of samples) {
    const index = Math.min(bucketCount - 1, Math.floor((sample.created - trendStart) / span * bucketCount));
    trendBuckets[index].total += sample.duration;
    trendBuckets[index].count++;
  }
  const trend = trendBuckets.map(({ total, count }) => count ? Math.round(total / count * 10) / 10 : null);
  return { ...history, githubProjectCount: githubProjects.length, complete, averageMinutes, distribution, runCount: durations.length, trend };
}
