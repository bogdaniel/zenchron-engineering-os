import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community';
import type { ColDef } from 'ag-grid-community';
import { Badge, Button, Select, Switch, Textarea, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { Project } from './projects';
import {
  IconChecks, IconChevronDown, IconChevronLeft, IconChevronRight, IconClockHour4, IconCode, IconDownload, IconFileText,
  IconFilter, IconGitMerge, IconGitPullRequest, IconLock, IconMessageCircle, IconPlus, IconSearch, IconShieldCheck,
  IconSparkles, IconUserCheck,
} from '@tabler/icons-react';
import { MetricCard } from './MetricCard';
import { PanelHeading } from './PanelHeading';
import { PageHeading } from './PageHeading';
import { PanelCard } from './PanelCard';
import { MonacoEditor } from './MonacoEditor';
import { reviewPreviewDiff, reviewPreviewProject, reviewPreviewPullRequests } from './review-preview';
import './reviews.css';
import './reviews-detail.css';
import './reviews-preview.css';
import './reviews-feedback.css';
import type { AgentRun } from './agents';

ModuleRegistry.registerModules([AllCommunityModule]);

function CodeDiff({ value, label }: { value: string; label: string }) {
  return <MonacoEditor className="reviews-code-editor" label={label} mode="diff" value={value} readOnly />;
}

function GitHubMarkdown({ value, className }: { value: string; className: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(value, { async: false, gfm: true }), {
    FORBID_TAGS: ['img'],
  }), [value]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

const columns: ColDef<AgentRun>[] = [
  { field: 'branch', headerName: 'Local branch', flex: 1.5, minWidth: 90 },
  { field: 'project_name', headerName: 'Project', flex: 1, minWidth: 78 },
  { field: 'status', headerName: 'Run', flex: 0.7, minWidth: 70 },
];
const githubItem = z.object({
  number: z.number(), title: z.string(), state: z.string(), html_url: z.string(), body: z.string().optional(),
  updated_at: z.string(), user: z.object({ login: z.string() }),
});
const pullRequestSchema = z.array(githubItem.extend({
  draft: z.boolean(), head: z.object({ ref: z.string() }), base: z.object({ ref: z.string() }),
}));
const issueSchema = z.array(githubItem.extend({ labels: z.array(z.object({ name: z.string() })) }));
type GitHubPullRequest = z.infer<typeof pullRequestSchema>[number];
type GitHubIssue = z.infer<typeof issueSchema>[number];
type ProviderQueueFilter = 'all' | 'open' | 'draft' | 'closed';
const reviewTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  accentColor: '#a36bff', backgroundColor: '#11121b', foregroundColor: '#e4dfef',
  borderColor: '#2c293d', headerBackgroundColor: '#171622', headerTextColor: '#a7a1b8', fontSize: 11,
});
const metrics = [
  ['Open pull requests', IconGitPullRequest], ['Draft pull requests', IconMessageCircle], ['Open issues', IconFileText],
  ['Avg. review time', IconClockHour4], ['Merge success rate', IconGitMerge], ['Policy gate pass', IconShieldCheck],
] as const;
const previewMetricLabels = ['Pull Requests', 'In Review', 'Review Queue', 'Avg. Review Time', 'Merge Success Rate', 'Policy Gate Pass'];
const tabs = ['Pull requests', 'Issues', 'Local branches', 'Code Review', 'Evidence', 'Merge Governance', 'Policies', 'Trusted-main'];
const stages = ['Code review', 'Evidence', 'Policy gates', 'CI', 'Merge'];
const detailTabs = [
  ['code-changes', 'Code changes', IconFileText], ['conversations', 'Conversations', IconMessageCircle],
  ['evidence', 'Evidence', IconShieldCheck], ['checklist', 'Checklist', IconChecks],
] as const;
const previewDetailTabs = [
  ['ai-suggestions', 'AI Suggestions', IconSparkles], ['approvals', 'Approvals', IconUserCheck],
] as const;
type DetailTab = typeof detailTabs[number][0] | typeof previewDetailTabs[number][0];

const diffSchema = z.object({ run_id: z.string(), diff: z.string(), truncated: z.boolean() });
const pullRequestDiffSchema = z.object({ diff: z.string().max(1 << 20) });

async function loadDiff(runID: string) {
  const response = await fetch(`/api/v1/agent-runs/${runID}/diff`);
  if (!response.ok) throw new Error(`Could not load local branch diff (${response.status})`);
  return diffSchema.parse(await response.json());
}

async function loadPullRequestDiff(projectID: string, number: number) {
  const response = await fetch(`/api/v1/projects/${projectID}/pull-requests/${number}/diff`);
  if (!response.ok) throw new Error((await response.text()).trim() || `Could not load pull request diff (${response.status})`);
  return pullRequestDiffSchema.parse(await response.json());
}

async function loadGitHubItems<T>(projectID: string, kind: 'issues' | 'pull-requests', schema: z.ZodType<T>) {
  const response = await fetch(`/api/v1/projects/${projectID}/${kind}`);
  if (!response.ok) throw new Error((await response.text()).trim() || `Could not load GitHub ${kind} (${response.status})`);
  return schema.parse(await response.json());
}

function summarizeDiff(diff: string) {
  let files = 0;
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files += 1;
      inHunk = false;
    } else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added += 1;
    else if (inHunk && line.startsWith('-')) removed += 1;
  }
  return { files, added, removed };
}

export function ReviewsPage({ runs, projects, designPreview = false }: { runs: AgentRun[]; projects: Project[]; designPreview?: boolean }) {
  const stacked = useMediaQuery('(max-width: 1150px)');
  const queryClient = useQueryClient();
  const [section, setSection] = useState<'pull-requests' | 'issues' | 'local-branches'>('pull-requests');
  const [detailTab, setDetailTab] = useState<DetailTab>('code-changes');
  const [projectID, setProjectID] = useState<string | null>(null);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [selectedProviderNumber, setSelectedProviderNumber] = useState<number | null>(null);
  const [providerSearch, setProviderSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState<ProviderQueueFilter>('all');
  const [comment, setComment] = useState('');
  const [providerReviewBody, setProviderReviewBody] = useState('');
  const [providerReviewStatus, setProviderReviewStatus] = useState('');
  const [issueCommentBody, setIssueCommentBody] = useState('');
  const [issueCommentStatus, setIssueCommentStatus] = useState('');
  const [issueStateStatus, setIssueStateStatus] = useState('');
  const gitHubProjects = designPreview ? [reviewPreviewProject] : projects.filter((project) => project.git_remote.startsWith('github.com/'));
  const selectedProject = gitHubProjects.find((project) => project.id === projectID) ?? gitHubProjects[0];
  const pullRequests = useQuery({
    queryKey: ['github-pull-requests', designPreview ? 'mock' : selectedProject?.id],
    queryFn: () => loadGitHubItems(selectedProject!.id, 'pull-requests', pullRequestSchema),
    enabled: Boolean(selectedProject) && !designPreview, refetchInterval: 60_000,
    initialData: designPreview ? reviewPreviewPullRequests : undefined,
  });
  const issues = useQuery({
    queryKey: ['github-issues', designPreview ? 'mock' : selectedProject?.id],
    queryFn: () => loadGitHubItems(selectedProject!.id, 'issues', issueSchema),
    enabled: Boolean(selectedProject) && !designPreview, refetchInterval: 60_000,
    initialData: designPreview ? [] : undefined,
  });
  const localBranches = runs.filter((run) => run.diff_available || ['queued', 'running', 'cancelled'].includes(run.status));
  const selected = localBranches.find((run) => run.id === selectedID) ?? localBranches[0];
  const providerItems = section === 'pull-requests' ? pullRequests.data ?? [] : issues.data ?? [];
  const searchTerm = providerSearch.trim().toLowerCase();
  const visibleProviderItems = providerItems.filter((item) => {
    if (!`${item.number} ${item.title} ${item.user.login}`.toLowerCase().includes(searchTerm)) return false;
    if (providerFilter === 'all') return true;
    if (section === 'pull-requests') {
      const pullRequest = item as GitHubPullRequest;
      return providerFilter === 'draft' ? pullRequest.draft : item.state === 'open' && !pullRequest.draft;
    }
    return item.state === providerFilter;
  });
  const providerQueueFilters: { value: ProviderQueueFilter; label: string; count: number }[] = section === 'pull-requests'
    ? [
      { value: 'all', label: 'All', count: providerItems.length },
      { value: 'open', label: 'Open', count: providerItems.filter((item) => item.state === 'open' && 'draft' in item && !item.draft).length },
      { value: 'draft', label: 'Draft', count: providerItems.filter((item) => 'draft' in item && item.draft).length },
    ]
    : [
      { value: 'all', label: 'All', count: providerItems.length },
      { value: 'open', label: 'Open', count: providerItems.filter((item) => item.state === 'open').length },
      { value: 'closed', label: 'Closed', count: providerItems.filter((item) => item.state === 'closed').length },
    ];
  const selectedProviderItem = visibleProviderItems.find((item) => item.number === selectedProviderNumber) ?? visibleProviderItems[0];
  const selectedPullRequest = section === 'pull-requests' ? selectedProviderItem as GitHubPullRequest | undefined : undefined;
  const selectedIssue = section === 'issues' ? selectedProviderItem as GitHubIssue | undefined : undefined;
  const providerQuery = section === 'issues' ? issues : pullRequests;
  const pullRequestDiff = useQuery({
    queryKey: ['github-pull-request-diff', designPreview ? 'mock' : selectedProject?.id, selectedPullRequest?.number],
    queryFn: () => loadPullRequestDiff(selectedProject!.id, selectedPullRequest!.number),
    enabled: Boolean(selectedProject && selectedPullRequest) && !designPreview, staleTime: 60_000,
    initialData: designPreview ? { diff: reviewPreviewDiff } : undefined,
  });
  const pullRequestPatch = pullRequestDiff.data?.diff;
  const canComment = Boolean(section === 'local-branches' && selected &&
    ['succeeded', 'failed', 'cancelled'].includes(selected.status) && selected.diff_available);
  const metricValues = designPreview ? [428, 37, 15, '8.4h', '98.7%', '99.2%'] : [
    pullRequests.data?.length, pullRequests.data?.filter((item) => item.draft).length, issues.data?.length,
    undefined, undefined, undefined,
  ];
  const reviewAction = useMutation({
    mutationFn: async ({ action, body }: { action: 'comments' | 'request-changes'; body: string }) => {
      const response = await fetch(`/api/v1/agent-runs/${selected!.id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment: body }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `Review action failed (${response.status})`);
    },
    onSuccess: async () => {
      setComment('');
      setDetailTab('conversations');
      await queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
    },
  });
  const providerReview = useMutation({
    mutationFn: async (input: { projectID: string; number: number; event: 'COMMENT' | 'REQUEST_CHANGES'; body: string }) => {
      const response = await fetch(`/api/v1/projects/${input.projectID}/pull-requests/${input.number}/reviews`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: input.body, event: input.event }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `GitHub review failed (${response.status})`);
      return { event: input.event, result: await response.json() as {
        agent_run_linked?: boolean; agent_run_queued?: boolean; feedback_sync_error?: string;
      } };
    },
    onMutate: () => setProviderReviewStatus(''),
    onSuccess: async ({ event, result }) => {
      setProviderReviewBody('');
      setProviderReviewStatus(result.feedback_sync_error ? 'Review submitted to GitHub, but run feedback could not sync.'
        : event === 'COMMENT' && result.agent_run_linked ? 'Comment submitted to GitHub and attached to the agent run.'
          : event === 'REQUEST_CHANGES' && result.agent_run_queued ? 'Changes requested on GitHub; agent run queued.'
            : event === 'REQUEST_CHANGES' && result.agent_run_linked
              ? 'Changes requested on GitHub; run feedback stored, but the agent is not eligible for another pass yet.'
              : event === 'COMMENT' ? 'Comment submitted to GitHub.' : 'Changes requested on GitHub.');
      await queryClient.invalidateQueries({ queryKey: ['github-pull-requests', selectedProject?.id] });
      await queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
    },
  });
  const issueComment = useMutation({
    mutationFn: async (input: { projectID: string; number: number; body: string }) => {
      const response = await fetch(`/api/v1/projects/${input.projectID}/issues/${input.number}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: input.body }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `GitHub issue comment failed (${response.status})`);
    },
    onMutate: () => setIssueCommentStatus(''),
    onSuccess: async () => {
      setIssueCommentBody('');
      setIssueCommentStatus('Comment submitted to GitHub.');
      await queryClient.invalidateQueries({ queryKey: ['github-issues', selectedProject?.id] });
    },
  });
  const issueState = useMutation({
    mutationFn: async (input: { projectID: string; number: number; state: 'open' | 'closed' }) => {
      const response = await fetch(`/api/v1/projects/${input.projectID}/issues/${input.number}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: input.state }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `GitHub issue update failed (${response.status})`);
      return input.state;
    },
    onMutate: () => setIssueStateStatus(''),
    onSuccess: async (state) => {
      setIssueStateStatus(`Issue ${state} on GitHub.`);
      await queryClient.invalidateQueries({ queryKey: ['github-issues', selectedProject?.id] });
    },
  });
  const cancelRun = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/v1/agent-runs/${selected!.id}/cancel`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.text()).trim() || `Cancel failed (${response.status})`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-runs'] }),
  });
  const diff = useQuery({
    queryKey: ['agent-run-diff', section, selected?.id, selected?.diff_attempt],
    queryFn: () => loadDiff(selected!.id),
    enabled: section === 'local-branches' && Boolean(selected),
  });
  const diffStats = useMemo(() => diff.data ? summarizeDiff(diff.data.diff) : null, [diff.data]);
  return (
    <div className={`reviews-page${designPreview ? ' reviews-design-preview' : ''}`} data-preview={designPreview ? 'mock' : undefined}>
      <section className="reviews-metrics" aria-label="Review metrics">
        {metrics.map(([label, Icon], index) => {
          const value = designPreview ? metricValues[index] : index < 3
            ? metricValues[index] ?? ((index === 0 ? pullRequests : index === 1 ? pullRequests : issues).isLoading ? '…' : 'Unavailable')
            : 'Unavailable';
          return <MetricCard
            className="reviews-metric"
            key={label}
            label={designPreview ? previewMetricLabels[index]! : label}
            value={value}
            icon={<Icon size={17} />}
          />;
        })}
      </section>
      <div className="reviews-title-row">
        <div className="reviews-title-copy">
          {designPreview ? <IconGitPullRequest className="reviews-title-icon" size={24} /> : <IconCode className="reviews-title-icon" size={24} />}
          <PageHeading className="reviews-heading-copy" title="Reviews" description="Pull requests, code review, evidence, and merge governance." />
        </div>
          {!designPreview && <Badge className={gitHubProjects.length && !providerQuery.isError ? 'reviews-provider-available' : 'reviews-unavailable'} variant="light">
          <i />{!selectedProject ? 'GitHub repository not connected' : providerQuery.isLoading ? 'Connecting to GitHub'
              : providerQuery.isError ? 'GitHub unavailable' : `GitHub · ${selectedProject.name}`}
        </Badge>}
      </div>
      <nav className="reviews-tabs" aria-label="Review sections">
        {designPreview ? <>
          {['Pull Requests 428', 'Code Review', 'Evidence', 'Merge Governance', 'Policies', 'Trusted-main'].map((tab, index) =>
            <button className={index === 0 ? 'selected' : ''} disabled={index > 0} key={tab}>{tab}</button>)}
          <span className="reviews-tab-spacer" />
          <Button className="reviews-filter" variant="default" disabled>Last 14 Days <IconChevronDown size={13} /></Button>
          <Button className="reviews-filter" variant="default" disabled><IconFilter size={13} /> All Repos <IconChevronDown size={13} /></Button>
        </> : tabs.map((tab, index) => {
          const key = (['pull-requests', 'issues', 'local-branches'] as const)[index];
          return <button
            className={section === key ? 'selected' : ''}
            disabled={index > 2}
            key={tab}
            onClick={() => {
              if (!key) return;
              setSection(key);
              setProviderSearch('');
              setProviderFilter('all');
              setProviderReviewStatus('');
            }}
          >{tab}</button>;
        })}
        <span className="reviews-tab-spacer" />
        {!designPreview && section !== 'local-branches' && <Select
          aria-label="GitHub repository"
          className="reviews-filter-select"
          data={gitHubProjects.map((project) => ({ value: project.id, label: project.name }))}
          placeholder="No GitHub repositories"
          value={selectedProject?.id ?? null}
          onChange={setProjectID}
          disabled={gitHubProjects.length < 2}
          nothingFoundMessage="No GitHub repositories"
        />}
        {section === 'local-branches' && <Button className="reviews-filter" variant="default" disabled>
          <IconFilter size={13} /> All repos <IconChevronDown size={13} />
        </Button>}
      </nav>
      <Group
        className={`reviews-workspace${stacked ? ' is-stacked' : ''}`}
        orientation={stacked ? 'vertical' : 'horizontal'}
        style={{ height: stacked ? '1090px' : designPreview ? 'calc(100vh - 290px)' : 'calc(100vh - 239px)' }}
        defaultLayout={stacked
          ? { queue: 33, detail: 39, summary: 28 }
          : { queue: 24, detail: 52, summary: 24 }}
      >
        <Panel id="queue" className="reviews-pane" minSize={stacked ? '340px' : '220px'}>
          <PanelCard className="reviews-queue" withBorder>
          <PanelHeading className="reviews-panel-heading"
            title={designPreview ? 'Pull Requests (428)' : section === 'pull-requests' ? 'Pull requests' : section === 'issues' ? 'Open issues' : 'Agent runs & local branches'}
            description={section === 'local-branches' ? 'Active requests and isolated agent changes' : selectedProject?.git_remote ?? 'GitHub project data'}
            actions={designPreview ? <Button className="reviews-new-pr" disabled><IconPlus size={13} /> New PR</Button>
              : <Badge className="reviews-required" variant="light">
                {section === 'local-branches' ? `${localBranches.length} runs` : `${providerItems.length} items`}
              </Badge>} />
          <div className="reviews-queue-tools">
            <TextInput
              leftSection={<IconSearch size={14} />}
              placeholder={designPreview ? 'Search PRs, branches, authors…'
                : section === 'issues' ? 'Search issues…'
                  : section === 'pull-requests' ? 'Search pull requests…' : 'Agent runs and branches'}
              aria-label={section === 'issues' ? 'Search issues' : section === 'pull-requests' ? 'Search pull requests' : 'Local branch diff list'}
              value={section === 'local-branches' ? '' : providerSearch}
              disabled={section === 'local-branches'}
              onChange={(event) => setProviderSearch(event.currentTarget.value)}
            />
            <IconFilter size={16} />
          </div>
          <div className="reviews-queue-states">{designPreview ? <>
              {['All 428', 'In Review 37', 'Changes Req. 12', 'Approved 276', 'Blocked 5', 'Draft 18'].map((filter, index) =>
                <button className={index === 0 ? 'selected' : ''} disabled key={filter}>{filter}</button>)}
            </> : section === 'local-branches' ? <>
              <span>All {localBranches.length}</span>
              <span>Succeeded {localBranches.filter((run) => run.status === 'succeeded').length}</span>
              <span>Failed {localBranches.filter((run) => run.status === 'failed').length}</span>
            </> : <>
              {providerQueueFilters.map((filter) => <button type="button" key={filter.value}
                aria-pressed={providerFilter === filter.value}
                className={providerFilter === filter.value ? 'selected' : ''}
                onClick={() => setProviderFilter(filter.value)}>{filter.label} {filter.count}</button>)}
              {providerQuery.isFetching && <span>Syncing…</span>}
            </>}
          </div>
          <div className="reviews-grid-wrap">
            {section === 'local-branches' ? <AgGridReact<AgentRun>
                rowData={localBranches} columnDefs={columns} theme={reviewTheme} getRowId={({ data }) => data.id}
                onRowClicked={({ data }) => data && setSelectedID(data.id)}
                overlayNoRowsTemplate="Agent runs and local branch diffs will appear here."
              /> : providerQuery.isLoading ? <div className="reviews-queue-empty">Loading GitHub items…</div>
                : providerQuery.isError ? <div className="reviews-queue-empty">GitHub data unavailable. Check the connection and try again.</div>
                  : visibleProviderItems.length ? <div className="reviews-provider-list">
                    {visibleProviderItems.map((item) => {
                      const pullRequest = section === 'pull-requests' ? item as GitHubPullRequest : undefined;
                      const selected = item.number === selectedProviderItem?.number;
                      const updatedAt = Date.parse(item.updated_at);
                      return <button type="button" key={item.number}
                        className={`reviews-provider-card${selected ? ' selected' : ''}`}
                        aria-pressed={selected}
                        onClick={() => {
                          setSelectedProviderNumber(item.number);
                          setProviderReviewBody('');
                          setProviderReviewStatus('');
                          setIssueCommentBody('');
                          setIssueCommentStatus('');
                          setIssueStateStatus('');
                        }}>
                        <span className="reviews-provider-card-top">
                          <span className="reviews-provider-number">{pullRequest ? <IconGitPullRequest size={13} /> : <IconFileText size={13} />} #{item.number}</span>
                          {designPreview && item.number === 4827 && <span className="reviews-preview-category">Feature</span>}
                          <span className="reviews-provider-state">{designPreview && pullRequest && item.number === 4827
                            ? 'In Review' : pullRequest?.draft ? 'Draft' : item.state}</span>
                        </span>
                        <strong>{item.title}</strong>
                        <span className="reviews-provider-meta">
                          <span className="reviews-provider-avatar" aria-hidden="true">{item.user.login.slice(0, 1).toUpperCase()}</span>
                          {item.user.login}
                          {pullRequest && <><span aria-hidden="true">·</span>{pullRequest.head.ref} → {pullRequest.base.ref}</>}
                          <span className="reviews-provider-date">{Number.isFinite(updatedAt)
                            ? new Date(updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Date unavailable'}</span>
                        </span>
                        {designPreview && item.number === 4827 && <span className="reviews-preview-signals">
                          <i>R 78</i><i>94%</i><i>CI ✓</i><i>Q 3</i>
                        </span>}
                      </button>;
                    })}
                  </div>
                  : <div className="reviews-queue-empty">{searchTerm
                    ? `No ${section === 'issues' ? 'issues' : 'pull requests'} match this search.`
                    : !selectedProject ? 'Connect a local GitHub checkout to see issues and pull requests.'
                      : `No open ${section === 'issues' ? 'issues' : 'pull requests'} in this repository.`}</div>}
          </div>
          {designPreview && <nav className="reviews-preview-pagination" aria-label="Pull request pages">
            <button type="button" disabled aria-label="Previous page"><IconChevronLeft size={13} /></button>
            {[1, 2, 3, 4, 5].map((page) => <button type="button" disabled
              aria-current={page === 1 ? 'page' : undefined}
              className={page === 1 ? 'selected' : ''} key={page}>
              {page}
            </button>)}
            <span aria-hidden="true">…</span>
            <button type="button" disabled>43</button>
            <button type="button" disabled aria-label="Next page"><IconChevronRight size={13} /></button>
          </nav>}
          </PanelCard>
        </Panel>
        <Separator id="queue-detail-separator" className="reviews-resize-handle" aria-label="Resize pull request queue and review detail" />
        <Panel id="detail" className="reviews-pane" minSize="340px">
          <PanelCard className="reviews-detail" withBorder>
          <PanelHeading
            className="reviews-detail-heading"
            icon={<span className="reviews-pr-icon"><IconGitPullRequest size={18} /></span>}
            title={section === 'local-branches' ? selected?.branch ?? 'No local branch selected'
              : selectedPullRequest ? `#${selectedPullRequest.number} ${selectedPullRequest.title}`
                : selectedIssue ? `#${selectedIssue.number} ${selectedIssue.title}` : `No open ${section === 'issues' ? 'issues' : 'pull requests'}`}
            description={section === 'local-branches'
              ? selected ? `${selected.project_name} · ${selected.agent_name} · ${selected.worker_name}` : 'Agent-run diffs will appear when a worker completes a run.'
              : selectedProviderItem && selectedProject ? `${selectedProject.name} · opened by ${selectedProviderItem.user.login}`
                : selectedProject?.git_remote ?? 'GitHub items will appear when a repository is selected.'}
            actions={<Badge className="reviews-required" variant="light">{designPreview ? 'In Review' : section === 'local-branches'
              ? selected?.status ?? 'Waiting for changes' : selectedProviderItem?.state ?? 'No open item'}</Badge>}
          />
          <div className="reviews-stage-row" aria-label="Review pipeline">
            {stages.map((stage, index) => (
              <div className="reviews-stage" key={stage}>
                {index > 0 && <span className="reviews-stage-line" />}
                <span className="reviews-stage-icon">
                  {index === 3 ? <IconChecks size={14} /> : index === 4 ? <IconGitMerge size={14} /> : (
                    <IconShieldCheck size={14} />
                  )}
                </span>
                <b>{stage}</b>
                <small>{designPreview ? ['2/3 approved', '94% complete', 'All passed', '8/8 passed', 'Ready'][index]
                    : index === 0 && selectedPullRequest ? (selectedPullRequest.draft ? 'Draft' : 'Open') : 'Unavailable'}</small>
              </div>
            ))}
          </div>
          <div className="reviews-detail-tabs" role="group" aria-label="Review detail sections">
            {(designPreview
              ? [detailTabs[0], detailTabs[1], previewDetailTabs[0], detailTabs[2], detailTabs[3], previewDetailTabs[1]]
              : detailTabs).map(([value, label, Icon], index) => <button key={value} type="button"
              aria-pressed={detailTab === value} onClick={() => setDetailTab(value)}>
              <Icon size={14} /> {label}{designPreview && <small>{[14, 8, 4, 7, 12, 2][index]}</small>}
            </button>)}
          </div>
          {detailTab !== 'code-changes' ? <div className="reviews-change-empty reviews-detail-tab-panel">
            {detailTab === 'conversations' ? <div className="reviews-conversation-panel">
              {section === 'local-branches' && selected?.review_comments.length ? (
                <div className="reviews-comments" aria-label="Review comments">
                  {selected.review_comments.map((item, index) => <div className="reviews-comment" key={`${item.created_at}-${index}`}>
                    <b>{item.request_changes ? 'Changes requested' : 'Comment'}</b><span>{item.body}</span>
                  </div>)}
                </div>
              ) : <p className="reviews-provider-readonly">{section === 'local-branches'
                ? 'No review comments are attached to this run yet.'
                : 'Existing GitHub conversation history is not synchronized yet.'}</p>}
              {selectedIssue && <div className="reviews-github-composer">
                <Textarea aria-label="GitHub issue comment" placeholder="Add a comment to this issue…"
                  value={issueCommentBody} onChange={(event) => setIssueCommentBody(event.currentTarget.value)}
                  maxLength={1000} minRows={2} maxRows={3} disabled={issueComment.isPending} />
                <small>GitHub records the comment under the configured control-plane token owner.</small>
                {issueComment.isError && <span className="reviews-action-error" role="alert">{issueComment.error.message}</span>}
                {issueCommentStatus && <span className="reviews-action-success" role="status">{issueCommentStatus}</span>}
                <div>
                  <Button disabled={!issueCommentBody.trim() || issueComment.isPending}
                    onClick={() => selectedProject && issueComment.mutate({ projectID: selectedProject.id,
                      number: selectedIssue.number, body: issueCommentBody.trim() })}>Add comment</Button>
                  <Button variant="default" disabled={issueState.isPending}
                    onClick={() => selectedProject && issueState.mutate({ projectID: selectedProject.id,
                      number: selectedIssue.number, state: selectedIssue.state === 'open' ? 'closed' : 'open' })}>
                    {selectedIssue.state === 'open' ? 'Close issue' : 'Reopen issue'}</Button>
                </div>
                {issueState.isError && <span className="reviews-action-error" role="alert">{issueState.error.message}</span>}
                {issueStateStatus && <span className="reviews-action-success" role="status">{issueStateStatus}</span>}
              </div>}
              {selectedPullRequest && <div className="reviews-github-composer">
                <Textarea aria-label="GitHub pull request review" placeholder="Leave a review comment or describe the changes needed…"
                  value={providerReviewBody} onChange={(event) => setProviderReviewBody(event.currentTarget.value)}
                  maxLength={1000} minRows={2} maxRows={3} disabled={designPreview || providerReview.isPending} />
                <small>GitHub records the review under the configured control-plane token owner.</small>
                {providerReview.isError && <span className="reviews-action-error" role="alert">{providerReview.error.message}</span>}
                {providerReviewStatus && <span className="reviews-action-success" role="status">{providerReviewStatus}</span>}
                <div>
                  <Button variant="default" disabled={designPreview || !providerReviewBody.trim() || providerReview.isPending}
                    onClick={() => selectedProject && providerReview.mutate({ projectID: selectedProject.id,
                      number: selectedPullRequest.number, event: 'COMMENT', body: providerReviewBody.trim() })}>Comment</Button>
                  <Button color="violet" disabled={designPreview || !providerReviewBody.trim() || providerReview.isPending}
                    onClick={() => selectedProject && providerReview.mutate({ projectID: selectedProject.id,
                      number: selectedPullRequest.number, event: 'REQUEST_CHANGES', body: providerReviewBody.trim() })}>
                    Request changes</Button>
                </div>
              </div>}
            </div> : detailTab === 'ai-suggestions' ? <div role="status"><IconSparkles size={24} />
              <b>AI Suggestions · 4</b><span>Add schema version to artifact metadata · High impact</span></div>
              : detailTab === 'approvals' ? <div role="status"><IconUserCheck size={24} />
                <b>Approvals · 2 of 3 approved</b><span>Jordan Kim and Riley Torres approved. Casey Morgan is pending.</span></div>
                : <div role="status">
                  {detailTab === 'evidence' ? <IconShieldCheck size={24} /> : <IconChecks size={24} />}
                  <b>{detailTab === 'evidence' ? 'Evidence unavailable' : 'Required checks unavailable'}</b>
                  <span>{detailTab === 'evidence' ? 'CI checks and evidence artifacts are not synchronized for this item yet.'
                    : 'The control plane does not currently load GitHub checks or policy results.'}</span>
                </div>}
          </div> : <div className="reviews-change-empty">
            {section !== 'local-branches' && selectedProviderItem ? (
              <div className="reviews-provider-detail">
                {section === 'pull-requests' && selectedPullRequest && <div className="reviews-diff-meta">
                  <span>{selectedPullRequest.head.ref} → {selectedPullRequest.base.ref}</span>
                  <a href={designPreview ? undefined : selectedPullRequest.html_url} target={designPreview ? undefined : '_blank'} rel="noreferrer">Open pull request on GitHub ↗</a>
                </div>}
                {section === 'issues' && selectedIssue && <div className="reviews-diff-meta">
                  <span>{selectedIssue.labels.map((label) => label.name).join(' · ') || 'No labels'}</span>
                  <a href={selectedIssue.html_url} target="_blank" rel="noreferrer">Open issue on GitHub ↗</a>
                </div>}
                <GitHubMarkdown className="reviews-pr-description reviews-markdown"
                  value={selectedProviderItem.body || 'No description provided.'} />
                {selectedPullRequest && <div className="reviews-pr-diff">
                  <div className="reviews-diff-meta"><span>Pull request diff</span><span>{selectedPullRequest.head.ref}</span></div>
                  {pullRequestDiff.isLoading ? <span>Loading pull request diff…</span>
                    : pullRequestDiff.isError ? <span className="reviews-action-error" role="alert">{pullRequestDiff.error.message}</span>
                      : pullRequestPatch && /^@@+ /m.test(pullRequestPatch)
                        ? <CodeDiff label="Pull request diff" value={pullRequestPatch} />
                        : <div className="reviews-pr-diff-empty" role="status">No readable text patch was returned. Review file changes on GitHub.</div>}
                </div>}
              </div>
            ) : section === 'local-branches' && selected && diff.data ? (
              <div className="reviews-diff-view">
                <div className="reviews-diff-meta">
                  <span>{selected.branch} → {selected.base_branch || 'base branch'}</span>
                  {selected.commit_sha && <span>Local commit {selected.commit_sha.slice(0, 7)}</span>}
                  {diff.data.truncated && <Badge color="yellow">Diff truncated at 128 KiB</Badge>}
                </div>
                {selected.pull_request_url ? (
                  <a className="reviews-pull-request-link" href={selected.pull_request_url} target="_blank" rel="noreferrer">
                    Open pull request #{selected.pull_request_number} ↗
                  </a>
                ) : selected.pull_request_error ? (
                  <span className="reviews-action-error" role="status">{selected.pull_request_error}</span>
                ) : selected.pull_request_enabled && selected.status === 'succeeded' ? (
                  <span className="reviews-provider-readonly" role="status">Pushing branch and opening pull request…</span>
                ) : selected.status === 'succeeded' && selected.commit_sha ? (
                  <span className="reviews-provider-readonly">Automatic pull-request creation needs a GitHub origin and control-plane token.</span>
                ) : null}
                <CodeDiff label="Local branch diff" value={diff.data.diff || 'No file changes in this run.'} />
              </div>
            ) : section === 'local-branches' && selected && diff.isLoading ? (
              <span>Loading isolated branch diff…</span>
            ) : section === 'local-branches' && selected && ['queued', 'running'].includes(selected.status) ? (
              <span>Run is {selected.cancel_requested ? 'stopping' : selected.status}; its isolated branch diff will appear when the worker stops.</span>
            ) : section === 'local-branches' && selected && diff.isError ? (
              <span role="alert">Could not load this branch diff. Refresh to retry.</span>
            ) : (
              <>
                <IconGitPullRequest size={24} />
                <b>{section === 'local-branches' ? 'No local branch diff selected'
                  : providerQuery.isError ? 'GitHub data unavailable'
                    : `No open ${section === 'issues' ? 'issue' : 'pull request'} selected`}</b>
                <span>{section === 'local-branches' ? 'Choose a completed agent run to inspect its isolated changes.'
                  : !selectedProject ? 'Connect a GitHub repository to see its open items.'
                    : providerQuery.isError ? 'Check the GitHub connection, then refresh to retry.'
                      : 'Select an item from the project queue.'}</span>
              </>
            )}
          </div>}
          {section === 'local-branches' ? <div className="reviews-comment-composer">
            <Textarea
              aria-label="Review comment"
              placeholder="Leave a comment or describe the changes needed…"
              value={comment}
              onChange={(event) => setComment(event.currentTarget.value)}
              maxLength={1000}
              minRows={2}
              maxRows={3}
              disabled={!canComment || reviewAction.isPending}
            />
            {selected && canComment && !selected.can_request_changes && (
              <span className="reviews-action-hint">
                Request changes requires an online worker, model runtime, code-write permission, and a remaining attempt.
              </span>
            )}
            {reviewAction.isError && <span className="reviews-action-error" role="alert">{reviewAction.error.message}</span>}
            <div>
              <Button
                variant="default"
                disabled={!canComment || !comment.trim() || reviewAction.isPending}
                onClick={() => reviewAction.mutate({ action: 'comments', body: comment.trim() })}
              >Add comment</Button>
              <Button
                color="violet"
                disabled={!selected?.can_request_changes || !comment.trim() || reviewAction.isPending}
                onClick={() => reviewAction.mutate({ action: 'request-changes', body: comment.trim() })}
              >Request changes</Button>
            </div>
          </div> : null}
          {section === 'local-branches' && <div className="reviews-review-actions">
            <Button
              variant="default"
              disabled={section !== 'local-branches' || !selected || !['queued', 'running'].includes(selected.status) || selected.cancel_requested || cancelRun.isPending}
              onClick={() => cancelRun.mutate()}
            >{selected?.cancel_requested ? 'Stopping…' : 'Cancel run'}</Button>
            <span />
            {cancelRun.isError && <span className="reviews-action-error" role="alert">{cancelRun.error.message}</span>}
          </div>}
          {detailTab === 'code-changes' && section === 'pull-requests' && selectedPullRequest &&
            <div className="reviews-context-panels" aria-label="Additional review context">
            <section className="reviews-context-card">
              <h4><IconSparkles size={13} /> AI Suggestions {designPreview && <small>4</small>}</h4>
              <span>{designPreview ? 'Add schema version to artifact metadata · High impact' : 'Suggestions are unavailable for this pull request.'}</span>
            </section>
            <section className="reviews-context-card">
              <h4><IconShieldCheck size={13} /> Evidence Artifacts {designPreview && <small>7</small>}</h4>
              <span>{designPreview ? 'evidence.json · 412 KB · Verified' : 'Artifact data is unavailable.'}</span>
            </section>
            <section className="reviews-context-card">
              <h4><IconChecks size={13} /> Review Checklist {designPreview && <small>12/12</small>}</h4>
              <span>{designPreview ? 'Code follows standards · Tests added · Evidence attached' : 'Provider check data is unavailable.'}</span>
            </section>
            {designPreview && <>
              <section className="reviews-context-card reviews-context-secondary">
                <h4><IconUserCheck size={13} /> Approvals <small>2/3</small></h4>
                <span>Jordan Kim · Approved · 1h ago</span><span>Riley Torres · Approved · 47m ago</span>
                <span>Casey Morgan · Pending</span>
              </section>
              <section className="reviews-context-card reviews-context-secondary">
                <h4><IconChecks size={13} /> Policy Gate Status <small>5/5</small></h4>
                <span>✓ Security　✓ Quality　✓ Compliance</span><span>✓ Risk　✓ Evidence</span>
              </section>
              <section className="reviews-context-card reviews-context-secondary">
                <h4><IconShieldCheck size={13} /> Trusted-main Readiness</h4>
                <span>Ready to Merge</span><span>All governance checks passed.</span>
              </section>
            </>}
          </div>}
          </PanelCard>
        </Panel>
        <Separator id="detail-summary-separator" className="reviews-resize-handle" aria-label="Resize review detail and summary" />
        <Panel id="summary" className="reviews-pane" minSize={stacked ? '300px' : '205px'}>
          <PanelCard className="reviews-summary" withBorder>
          <PanelHeading className="reviews-panel-heading" title="Review Summary" description={section === 'local-branches'
            ? 'Local branch context' : selectedPullRequest ? 'GitHub pull request context'
              : selectedIssue ? 'GitHub issue context' : 'Select a GitHub item for context'}
            actions={<IconShieldCheck size={17} />} />
          <GitHubMarkdown className="reviews-summary-copy reviews-markdown" value={section === 'local-branches'
            ? selected?.output ?? selected?.error ?? 'Select a local branch to review its agent run.'
            : selectedProviderItem?.body ?? 'Select a GitHub item to review its description.'} />
          <div className="reviews-summary-stats">
            <div><span>Files changed</span><b>{designPreview ? '6' : section === 'local-branches' && diffStats ? `${diffStats.files}${diff.data?.truncated ? '+' : ''}` : 'Unavailable'}</b></div>
            <div><span>Lines added</span><b>{designPreview ? '+427' : section === 'local-branches' && diffStats ? `+${diffStats.added}${diff.data?.truncated ? '+' : ''}` : 'Unavailable'}</b></div>
            <div><span>{designPreview ? 'Risk score' : 'Lines removed'}</span><b>{designPreview ? '78/100 · High' : section === 'local-branches' && diffStats ? `−${diffStats.removed}${diff.data?.truncated ? '+' : ''}` : 'Unavailable'}</b></div>
            <div><span>Evidence completeness</span><b>{designPreview ? '94%' : 'Unavailable'}</b></div>
          </div>
          <div className="reviews-checks-heading"><b>Required checks</b><span>{designPreview ? '8/8 All Passed' : 'Unavailable'}</span></div>
          <div className={`reviews-check-empty${designPreview ? ' reviews-preview-checks' : ''}`}>
            {designPreview ? <><span>✓ CI / Build (8 jobs) <b>3m 41s</b></span><span>✓ Tests (1,284) <b>4m 07s</b></span>
              <span>✓ Coverage (87.6% ≥ 85%) <b>28s</b></span><span>✓ Security Scan (SAST/SCA) <b>1m 32s</b></span>
              <span>✓ Evidence Completeness (≥ 90%) <b>94%</b></span></> : <><IconLock size={16} /> Checks and policy results need provider data.</>}
          </div>
          <div className="reviews-summary-actions">
            <Button variant="default" disabled fullWidth><IconDownload size={14} /> Export evidence</Button>
            <div className="reviews-summary-review-actions">
              <Button color="green" disabled>Approve</Button>
              {selectedPullRequest && <Button color="violet" disabled={designPreview} onClick={() => setDetailTab('conversations')}>Request changes</Button>}
              {selectedIssue && <Button variant="default" onClick={() => setDetailTab('conversations')}>Add comment</Button>}
            </div>
          </div>
          <div className="reviews-governance-heading"><IconGitMerge size={15} /><b>Merge Governance</b></div>
          {designPreview && <div className="reviews-governance-row"><span>Merge strategy</span><b>Squash &amp; Merge</b></div>}
          <div className="reviews-governance-row"><span>Target branch</span><b>{designPreview ? 'trusted-main' : section === 'local-branches'
            ? selected?.base_branch || 'Unavailable' : selectedPullRequest?.base.ref || 'Unavailable'}</b></div>
          {designPreview && <>
            <div className="reviews-governance-row"><span>Policy</span><b>Core Product v2.4</b></div>
            <div className="reviews-governance-row"><span>Auto-merge (when ready)</span><Switch checked disabled size="xs" aria-label="Auto-merge when ready" /></div>
          </>}
          <Button className="reviews-merge-button" disabled fullWidth>{designPreview ? 'Merge to Trusted-main' : 'Merge to protected branch'}</Button>
          </PanelCard>
        </Panel>
      </Group>
    </div>
  );
}
