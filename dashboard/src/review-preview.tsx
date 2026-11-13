import { useState } from 'react';
import { Sparkline } from '@mantine/charts';
import { Badge } from '@mantine/core';
import type { Project } from './projects';
import type { GitHubPullRequest, PullRequestDiff, ReviewContextData, ReviewSignals, ReviewsSource } from './reviewsView';

const reviewPreviewProject: Project = {
  id: '48274827482748274827482748274827',
  name: 'Nova Platform',
  branch: 'main',
  git_remote: 'github.com/zenchron/nova-platform',
  worker_id: '0123456789abcdef0123456789abcdef',
  worker_name: 'Development Mac',
  last_seen: '2025-01-21T10:24:00Z',
  worker_status: 'online',
};

const pullRequest = (number: number, title: string, author: string, head: string, state = 'open', draft = false) => ({
  number,
  title,
  state,
  repository: 'Nova Platform',
  html_url: '#',
  body: number === 4827
    ? 'Adds AI feedback signals and end-to-end evidence capture for code reviews, including artifact collection, attestation, and policy context. Improves review quality, traceability, and merge governance.'
    : '',
  draft,
  updated_at: '2025-01-21T10:24:00Z',
  user: { login: author },
  head: { ref: head },
  base: { ref: 'main' },
});

const reviewPreviewPullRequests = [
  pullRequest(4827, 'Add AI feedback signals and evidence capture', 'Maya Patel', 'feat/review-ai-evidence'),
  pullRequest(4819, 'Resolve flaky test in evidence pipeline', 'Jordan Kim', 'fix/evidence-flaky', 'open'),
  pullRequest(4816, 'Refactor review orchestration agents', 'Riley Torres', 'refactor/review-orchestration'),
  pullRequest(4812, 'Harden evidence artifact signing', 'Casey Morgan', 'security/artifact-signing'),
  pullRequest(4808, 'Update policy rules and merge thresholds', 'Alex Chen', 'chore/policy-rules'),
];

const reviewPreviewCardDetails: Record<number, ReviewSignals & {
  openedAge?: string; commits?: number; additions?: number; deletions?: number; updatedAge?: string;
}> = {
  4827: { category: 'Feature', risk: 78, evidence: 94, ciPassed: true, comments: 3, otherReviewers: 2,
    openedAge: '2h ago', commits: 12, additions: 427, deletions: 68, updatedAge: '18m ago' },
  4819: { category: 'Fix', risk: 42, evidence: 100, ciPassed: true, comments: 2, otherReviewers: 1 },
  4816: { category: 'Refactor', risk: 55, evidence: 96, ciPassed: true, comments: 0, otherReviewers: 3 },
  4812: { category: 'Security', risk: 91, evidence: 87, ciPassed: false, comments: 5, otherReviewers: 2 },
  4808: { category: 'Chore', risk: 18, evidence: 100, ciPassed: true, comments: 0, otherReviewers: 1 },
};

const reviewPreviewDiff = `diff --git a/src/review/evidence_capture.ts b/src/review/evidence_capture.ts
index 6d3aa72..746bb91 100644
--- a/src/review/evidence_capture.ts
+++ b/src/review/evidence_capture.ts
@@ -118,12 +118,18 @@ export async function captureEvidence(ctx: ReviewCtx) {
   const signals = await aiFeedback.analyze(diff, context);
-  const evidence = await evidenceCapture.build({ diff, signals });
+  const evidence = await evidenceCapture.build({
+    diff,
+    signals,
+    artifacts: await collectArtifacts(ctx),
+    attestation: await signEvidence(ctx),
+    policyContext: ctx.policy,
+  });
   return evidence;
 }`;

export const mockPullRequestDiff: PullRequestDiff = { patch: reviewPreviewDiff, loading: false, error: null };

type MockStatus = 'in-review' | 'changes-requested' | 'approved' | 'blocked' | 'draft';
const statusLabels: Record<MockStatus, string> = {
  'in-review': 'In Review', 'changes-requested': 'Changes Requested', approved: 'Approved', blocked: 'Blocked', draft: 'Draft',
};
const fixtureStatuses: Record<number, MockStatus> = {
  4827: 'in-review', 4819: 'changes-requested', 4816: 'approved', 4812: 'blocked', 4808: 'approved',
};
const metrics: ReviewsSource['metrics'] = [
  { value: 428, trend: <span className="reviews-preview-metric-trend"><Badge>↑ +14%</Badge><Sparkline role="img" aria-label="Pull requests trend" data={[3, 4, 3, 6, 5, 7, 9]} color="violet.5" w={54} h={24} withGradient={false} /></span> },
  { value: 37, trend: <span className="reviews-preview-metric-trend"><span className="reviews-preview-metric-live"><i />Live</span><Sparkline role="img" aria-label="In review trend" data={[2, 3, 3, 4, 5, 5, 7]} color="teal.4" w={54} h={24} withGradient={false} /></span> },
  { value: 15, trend: <span className="reviews-preview-metric-trend"><Badge>↑ +3</Badge><span className="reviews-preview-metric-bars" aria-hidden="true">{[8, 12, 18, 24, 30].map((height) => <i key={height} style={{ height }} />)}</span></span> },
  { value: '8.4h', trend: <span className="reviews-preview-metric-trend"><Badge>↓ -28%</Badge><Sparkline role="img" aria-label="Review time trend" data={[8, 7, 8, 6, 5, 4, 3]} color="teal.4" w={54} h={24} withGradient={false} /></span> },
  { value: '98.7%', trend: <Badge className="reviews-preview-metric-change">↑ +1.9pp</Badge> },
  { value: '99.2%', trend: <Badge className="reviews-preview-metric-change">↑ +0.8pp</Badge> },
];
const context: ReviewContextData = {
  suggestions: [
    { title: 'Add schema version to evidence artifacts', impact: 'Traceability · High' },
    { title: 'Handle artifact collection failures', impact: 'Reliability · Medium' },
    { title: 'Add tests for evidence builder', impact: 'Test coverage · Medium' },
  ],
  suggestionCount: '4',
  artifacts: [
    'evidence.json · 412 KB', 'review-signals.json · 96 KB', 'test-results.xml · 1.8 MB',
    'coverage-report.html · 724 KB', 'sbom.spdx.json · 1.1 MB', 'attestation.sig · 3 KB', 'policy-trace.json · 88 KB',
  ],
  checklist: {
    done: '12/12',
    items: [
      'Code follows standards', 'Tests added/updated · coverage ≥85%', 'Evidence artifacts generated',
      'Security scan (SAST/SCA) passed', 'No high-risk dependencies', 'Policy gates configured', 'Trusted-main criteria met',
    ],
  },
  approvals: { summary: '2/3', lines: ['Jordan Kim · Approved · 1h ago', 'Riley Torres · Approved · 47m ago', 'Casey Morgan · Pending'] },
  policyGates: { summary: '5/5', lines: ['✓ Security　✓ Quality　✓ Compliance', '✓ Risk　✓ Evidence'] },
  readiness: ['Ready to Merge', 'All governance checks passed.'],
};
const thread = [
  { initials: 'AC', color: 'violet', author: 'Alex Chen · 32m ago', text: 'Good addition. Can we include artifact schema version for traceability?' },
  { initials: 'MP', color: 'grape', author: 'Maya Patel · 29m ago', text: 'Done — added schemaVersion in the next commit (c71e3ca)' },
];
const checks: [string, string][] = [
  ['CI / Build (8 jobs)', '3m 41s'], ['Tests (1,284)', '4m 07s'], ['Coverage (87.6% ≥ 85%)', '28s'],
  ['Security Scan (SAST/SCA)', '1m 32s'], ['Dependency Policy', '18s'], ['Evidence Completeness (≥ 90%)', '94%'],
  ['Policy Gates', '6s'], ['Trusted-main Criteria', '4s'],
];
const defaultDateRange = 14;

/** The approved fixtures. Every action changes this tab's state only and sends nothing. */
export function useMockReviews(): ReviewsSource {
  const [items, setItems] = useState(reviewPreviewPullRequests);
  const [dateRange, setDateRange] = useState(defaultDateRange);
  const [repository, setRepository] = useState('all');
  const [statuses, setStatuses] = useState<Record<number, MockStatus>>({});
  const [mergedNumbers, setMergedNumbers] = useState<number[]>([]);
  const [bookmarkedNumbers, setBookmarkedNumbers] = useState<number[]>([]);
  const [autoMerge, setAutoMerge] = useState(true);
  const cutoff = Date.parse(reviewPreviewProject.last_seen) - dateRange * 24 * 60 * 60 * 1000;
  const statusOf = (pullRequest: GitHubPullRequest): MockStatus =>
    statuses[pullRequest.number] ?? fixtureStatuses[pullRequest.number] ?? (pullRequest.draft ? 'draft' : 'in-review');
  const setStatus = (number: number, status: MockStatus) => setStatuses((current) => ({ ...current, [number]: status }));
  return {
    sections: ['pull-requests'],
    metrics,
    repositories: [{ value: 'all', label: 'All Repos' }, { value: 'nova', label: reviewPreviewProject.name }],
    repository,
    repositoryLabel: repository === 'all' ? 'All Repos' : reviewPreviewProject.name,
    chooseRepository: setRepository,
    dateRange: { days: dateRange, choose: setDateRange },
    resetFilters: () => {
      setDateRange(defaultDateRange);
      setRepository('all');
      return 'Review filters reset in this preview.';
    },
    project: reviewPreviewProject,
    pullRequests: {
      items: items.filter((item) => (repository === 'all' || item.repository === reviewPreviewProject.name)
        && Date.parse(item.updated_at) >= cutoff),
      loading: false, failed: false, syncing: false,
    },
    pullRequestTotal: '428',
    pullRequestFilters: [
      { value: 'all', label: 'All 428' }, { value: 'in-review', label: 'In Review 37' },
      { value: 'changes-requested', label: 'Changes Req. 12' }, { value: 'approved', label: 'Approved 276' },
      { value: 'blocked', label: 'Blocked 5' }, { value: 'draft', label: 'Draft 18' },
    ],
    pullRequestStatus: (pullRequest) => {
      const value = statusOf(pullRequest);
      return { value, label: statusLabels[value], tone: value };
    },
    signals: (number) => reviewPreviewCardDetails[number],
    issues: { items: [], loading: false, failed: false, syncing: false },
    runs: { items: [], loading: false, failed: false, syncing: false },
    view: (pullRequest) => {
      const status = pullRequest && statusOf(pullRequest);
      const merged = Boolean(pullRequest && mergedNumbers.includes(pullRequest.number));
      const details = pullRequest && reviewPreviewCardDetails[pullRequest.number];
      return {
        badge: pullRequest && (merged ? 'Merged' : statusLabels[status!]),
        metadata: !pullRequest ? undefined : details?.commits !== undefined
          ? `Opened by ${pullRequest.user.login} · ${details.openedAge} · ${details.commits} commits · +${details.additions} −${details.deletions} · Updated ${details.updatedAge}`
          : `${reviewPreviewProject.name} · opened by ${pullRequest.user.login}`,
        stages: [
          status === 'approved' ? '3/3 approved' : status === 'changes-requested' ? '1/3 approved' : '2/3 approved',
          '94% complete', 'All passed', '8/8 passed', merged ? 'Merged to trusted-main' : 'Ready',
        ],
        conversation: {
          note: pullRequest && statuses[pullRequest.number] === 'changes-requested'
            ? `Changes requested on PR #${pullRequest.number} · simulated locally for this preview.`
            : 'Existing GitHub conversation history is not synchronized yet.',
          announced: status === 'changes-requested',
        },
        diff: { file: 'src/review/evidence_capture.ts', added: '+37', removed: '−12', thread },
        stats: { files: '6', added: '+427', commits: '12', removed: '−68', risk: '78 / 100 (High)', evidence: '94%' },
        evidencePercent: 94,
        checks: { summary: '8/8 All Passed', items: checks },
        governance: { strategy: 'Squash & Merge', target: 'trusted-main', policy: 'Core Product v2.4' },
        mergeLabel: merged ? 'Merged to Trusted-main' : 'Merge to Trusted-main',
      };
    },
    detailTabCounts: [14, 8, 4, 7, 12, 2],
    notes: {
      suggestions: ['AI Suggestions · 4', 'Add schema version to artifact metadata · High impact'],
      approvals: ['Approvals · 2 of 3 approved', 'Jordan Kim and Riley Torres approved. Casey Morgan is pending.'],
    },
    context,
    pagination: { note: 'Sample page · 5 pull requests', reason: 'Only one local sample page is available' },
    createPullRequest: (title, branch) => {
      const number = Math.max(...items.map((item) => item.number), 4827) + 1;
      setItems((current) => [{ ...reviewPreviewPullRequests[0]!, number, title, draft: true,
        updated_at: reviewPreviewProject.last_seen, user: { login: 'Alex Chen' }, head: { ref: branch },
        body: 'Illustrative pull request created in the local preview.' }, ...current]);
      setStatus(number, 'draft');
      return number;
    },
    approve: (pullRequest) => setStatus(pullRequest.number, 'approved'),
    requestChanges: (pullRequest) => setStatus(pullRequest.number, 'changes-requested'),
    merge: (pullRequest) => {
      setMergedNumbers((current) => current.includes(pullRequest.number) ? current : [...current, pullRequest.number]);
      setStatus(pullRequest.number, 'approved');
    },
    exportEvidence: (pullRequest) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ pullRequest, diff: reviewPreviewDiff }, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `pr-${pullRequest.number}-preview-evidence.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    bookmarks: {
      has: (number) => bookmarkedNumbers.includes(number),
      toggle: (number) => setBookmarkedNumbers((saved) => saved.includes(number)
        ? saved.filter((item) => item !== number) : [...saved, number]),
    },
    autoMerge: { checked: autoMerge, set: setAutoMerge },
  };
}
