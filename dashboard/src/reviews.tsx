import { Button, Menu, Modal, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  IconChevronDown, IconClockHour4, IconCode, IconDots, IconFileText, IconGitBranch, IconGitMerge, IconGitPullRequest,
  IconLock, IconMessageCircle, IconShieldCheck,
} from '@tabler/icons-react';
import type { AgentRun } from './agentsData';
import { MetricCard } from './MetricCard';
import { PageHeading } from './PageHeading';
import type { Project } from './projects';
import { mockPullRequestDiff, useMockReviews } from './review-preview';
import { ReviewDetail } from './ReviewDetail';
import { ReviewQueue } from './ReviewQueue';
import { ReviewSummary } from './ReviewSummary';
import { loadDiff, summarizeDiff, useLivePullRequestDiff, useLiveReviews } from './reviewsView';
import type { DetailTab, ReviewSection } from './reviewsView';
import './reviews.css';
import './reviews-detail.css';
import './reviews-preview.css';
import './reviews-feedback.css';

// Overview reads a run's diff through this module.
export { loadDiff };

const metrics = [
  ['Pull Requests', IconGitPullRequest], ['In Review', IconMessageCircle], ['Review Queue', IconFileText],
  ['Avg. Review Time', IconClockHour4], ['Merge Success Rate', IconGitMerge], ['Policy Gate Pass', IconShieldCheck],
] as const;
const queueTabs = [
  ['pull-requests', 'Pull Requests', IconGitPullRequest], ['issues', 'Issues', IconFileText],
  ['local-branches', 'Local branches', IconGitBranch],
] as const;
/** Tabs that open a detail tab of the selected item instead of changing the queue. */
const shortcutTabs = [
  ['code-review', 'Code Review', 'code-changes', IconCode], ['evidence', 'Evidence', 'evidence', IconShieldCheck],
  ['governance', 'Merge Governance', 'approvals', IconGitMerge], ['policies', 'Policies', 'checklist', IconLock],
  ['trusted-main', 'Trusted-main', 'approvals', IconGitMerge],
] as const;
const dateRanges = [7, 14, 30];

function pullRequestFromAddress() {
  const value = Number(new URLSearchParams(window.location.search).get('pull'));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function ReviewsPage({ runs, runsLoading = false, runsFailed = false, projects, designPreview = false }: {
  runs: AgentRun[]; runsLoading?: boolean; runsFailed?: boolean; projects: Project[]; designPreview?: boolean;
}) {
  const stacked = useMediaQuery('(max-width: 1150px)');
  const mock = useMockReviews();
  const live = useLiveReviews(!designPreview, projects, { items: runs, loading: runsLoading, failed: runsFailed });
  const source = designPreview ? mock : live;
  const [section, setSection] = useState<ReviewSection>('pull-requests');
  const [activeTab, setActiveTab] = useState<string>('pull-requests');
  const [detailTab, setDetailTab] = useState<DetailTab>('code-changes');
  const [selectedRunID, setSelectedRunID] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState(pullRequestFromAddress);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const [newPullRequest, setNewPullRequest] = useState<{ title: string; branch: string } | null>(null);

  const term = search.trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(term);
  const visiblePullRequests = source.pullRequests.items.filter((item) =>
    matches(`${item.number} ${item.title} ${item.user.login} ${item.head.ref}`)
      && (filter === 'all' || source.pullRequestStatus(item).value === filter));
  const visibleIssues = source.issues.items.filter((item) =>
    matches(`${item.number} ${item.title} ${item.user.login}`) && (filter === 'all' || item.state === filter));
  const pick = <T extends { number: number }>(items: T[]) => items.find((item) => item.number === selectedNumber) ?? items[0];
  const pullRequest = section === 'pull-requests' ? pick(visiblePullRequests) : undefined;
  const issue = section === 'issues' ? pick(visibleIssues) : undefined;
  const run = section === 'local-branches'
    ? source.runs.items.find((item) => item.id === selectedRunID) ?? source.runs.items[0] : undefined;

  const liveDiff = useLivePullRequestDiff(!designPreview, source.project?.id, pullRequest?.number);
  const pullRequestDiff = designPreview ? mockPullRequestDiff : liveDiff;
  const runDiff = useQuery({
    queryKey: ['agent-run-diff', section, run?.id, run?.diff_attempt],
    queryFn: () => loadDiff(run!.id),
    enabled: Boolean(run),
  });
  const runStats = useMemo(() => {
    if (!runDiff.data) return undefined;
    const { files, added, removed } = summarizeDiff(runDiff.data.diff);
    // A truncated diff undercounts, so the totals are marked as lower bounds.
    const more = runDiff.data.truncated ? '+' : '';
    return { files: `${files}${more}`, added: `+${added}${more}`, removed: `−${removed}${more}` };
  }, [runDiff.data]);
  const pullRequestView = source.view(pullRequest, pullRequestDiff.patch);
  const view = section === 'local-branches'
    ? { ...pullRequestView, stats: runStats ?? {}, governance: { target: run?.base_branch } } : pullRequestView;

  const clearSelectionState = () => {
    setMessage('');
    setDraft('');
  };
  const openQueue = (next: ReviewSection) => {
    setSection(next);
    setActiveTab(next);
    setDetailTab('code-changes');
    setSearch('');
    setFilter('all');
    clearSelectionState();
  };
  const resetFilters = () => {
    setSearch('');
    setFilter('all');
    setMessage(source.resetFilters());
  };
  const createPullRequest = () => {
    const title = newPullRequest?.title.trim();
    const branch = newPullRequest?.branch.trim();
    if (!title || !branch || !source.createPullRequest) return;
    setSelectedNumber(source.createPullRequest(title, branch));
    openQueue('pull-requests');
    setNewPullRequest(null);
  };
  const tabCounts: Record<ReviewSection, string | undefined> = {
    'pull-requests': source.pullRequestTotal,
    issues: source.issues.loading || source.issues.failed || !source.project ? undefined : String(source.issues.items.length),
    'local-branches': source.runs.loading || source.runs.failed ? undefined : String(source.runs.items.length),
  };
  return (
    <div className="reviews-page reviews-design-preview" data-preview={designPreview ? 'mock' : undefined}>
      <section className="reviews-metrics" aria-label="Review metrics">
        {metrics.map(([label, Icon], index) => <MetricCard className="reviews-metric" key={label} label={label}
          value={source.metrics[index]!.value} trend={source.metrics[index]!.trend} icon={<Icon size={17} />} />)}
      </section>
      <div className="reviews-title-row">
        <div className="reviews-title-copy">
          <IconGitPullRequest className="reviews-title-icon" size={24} />
          <PageHeading className="reviews-heading-copy" title="Reviews" description="Pull requests, code review, evidence, and merge governance." />
        </div>
      </div>
      <nav className="reviews-tabs" aria-label="Review sections">
        {queueTabs.filter(([key]) => source.sections.includes(key)).map(([key, label, Icon]) => <button type="button" key={key}
          aria-pressed={activeTab === key} className={activeTab === key ? 'selected' : ''} onClick={() => openQueue(key)}>
          <Icon size={13} aria-hidden="true" />{label}{tabCounts[key] && <small>{tabCounts[key]}</small>}
        </button>)}
        {shortcutTabs.map(([key, label, target, Icon]) => <button type="button" key={key} aria-pressed={activeTab === key}
          className={activeTab === key ? 'selected' : ''} onClick={() => { setActiveTab(key); setDetailTab(target); }}>
          <Icon size={13} aria-hidden="true" />{label}
        </button>)}
        <span className="reviews-tab-spacer" />
        <Menu withinPortal position="bottom-end">
          <Menu.Target><Button className="reviews-filter reviews-preview-filter" variant="default" aria-label="Review date range"
            disabled={!source.dateRange} title={source.dateRange ? undefined : 'Open items are listed without a date filter'}>
            {source.dateRange ? <>Last {source.dateRange.days} Days</> : 'All Dates'} <IconChevronDown size={13} />
          </Button></Menu.Target>
          <Menu.Dropdown>{dateRanges.map((days) => <Menu.Item key={days}
            onClick={() => source.dateRange?.choose(days)}>Last {days} Days</Menu.Item>)}</Menu.Dropdown>
        </Menu>
        <Menu withinPortal position="bottom-end">
          <Menu.Target><Button className="reviews-filter reviews-preview-filter" variant="default" aria-label="Review repository"
            disabled={source.repositories.length < 2}
            title={source.repositories.length < 2 ? 'No other GitHub repository is connected' : undefined}>
            {source.repositoryLabel} <IconChevronDown size={13} />
          </Button></Menu.Target>
          <Menu.Dropdown>{source.repositories.map((repository) => <Menu.Item key={repository.value}
            onClick={() => { source.chooseRepository(repository.value); clearSelectionState(); }}>{repository.label}</Menu.Item>)}</Menu.Dropdown>
        </Menu>
        <Menu withinPortal position="bottom-end">
          <Menu.Target><Button className="reviews-filter reviews-preview-filter" variant="default" aria-label="More review filters"><IconDots size={15} /></Button></Menu.Target>
          <Menu.Dropdown><Menu.Item onClick={resetFilters}>Reset queue filters</Menu.Item></Menu.Dropdown>
        </Menu>
      </nav>
      <Group
        className={`reviews-workspace${stacked ? ' is-stacked' : ''}`}
        orientation={stacked ? 'vertical' : 'horizontal'}
        style={{ height: stacked ? '1090px' : 'calc(100vh - 290px)' }}
        defaultLayout={stacked
          ? { queue: 33, detail: 39, summary: 28 }
          : { queue: 24, detail: 52, summary: 24 }}
      >
        <Panel id="queue" className="reviews-pane" minSize={stacked ? '340px' : '220px'}>
          <ReviewQueue source={source} section={section} items={section === 'issues' ? visibleIssues : visiblePullRequests}
            searching={Boolean(term)} search={search} onSearch={setSearch} filter={filter} onFilter={setFilter}
            selectedNumber={(pullRequest ?? issue)?.number}
            onSelect={(number) => { setSelectedNumber(number); clearSelectionState(); }}
            onSelectRun={setSelectedRunID} onNewPullRequest={() => setNewPullRequest({ title: '', branch: '' })} />
        </Panel>
        <Separator id="queue-detail-separator" className="reviews-resize-handle" aria-label="Resize pull request queue and review detail" />
        <Panel id="detail" className="reviews-pane" minSize="340px">
          <ReviewDetail source={source} section={section} view={view} pullRequest={pullRequest} issue={issue} run={run}
            pullRequestDiff={pullRequestDiff} runDiff={runDiff} detailTab={detailTab} onDetailTab={setDetailTab}
            draft={{ value: draft, set: setDraft }} message={message} onMessage={setMessage} />
        </Panel>
        <Separator id="detail-summary-separator" className="reviews-resize-handle" aria-label="Resize review detail and summary" />
        <Panel id="summary" className="reviews-pane" minSize={stacked ? '300px' : '205px'}>
          <ReviewSummary source={source} view={view} pullRequest={pullRequest} issue={issue}
            status={pullRequest && source.pullRequestStatus(pullRequest)}
            context={section === 'local-branches' ? 'Local branch context' : pullRequest ? 'GitHub pull request context'
              : issue ? 'GitHub issue context' : 'Select a GitHub item for context'}
            copy={section === 'local-branches' ? run?.output ?? run?.error ?? 'Select a local branch to review its agent run.'
              : (pullRequest ?? issue)?.body ?? 'Select a GitHub item to review its description.'}
            onOpenConversations={() => setDetailTab('conversations')} />
        </Panel>
      </Group>
      <Modal opened={newPullRequest !== null} onClose={() => setNewPullRequest(null)} title="New pull request · preview only" centered>
        <form onSubmit={(event) => { event.preventDefault(); createPullRequest(); }}>
          <TextInput label="Pull request title" aria-label="Pull request title" required value={newPullRequest?.title ?? ''}
            onChange={(event) => setNewPullRequest({ title: event.currentTarget.value, branch: newPullRequest?.branch ?? '' })} />
          <TextInput mt="sm" label="Source branch" aria-label="Source branch" required value={newPullRequest?.branch ?? ''}
            onChange={(event) => setNewPullRequest({ title: newPullRequest?.title ?? '', branch: event.currentTarget.value })} />
          <Button mt="md" type="submit" disabled={!newPullRequest?.title.trim() || !newPullRequest.branch.trim()}>Create preview PR</Button>
        </form>
      </Modal>
    </div>
  );
}
