import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community';
import type { ColDef } from 'ag-grid-community';
import { Button, TextInput } from '@mantine/core';
import { IconFileText, IconFilter, IconGitPullRequest, IconPlus, IconSearch } from '@tabler/icons-react';
import type { AgentRun } from './agentsData';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import type { GitHubIssue, GitHubPullRequest, ReviewSection, ReviewsSource } from './reviewsView';

ModuleRegistry.registerModules([AllCommunityModule]);

const columns: ColDef<AgentRun>[] = [
  { field: 'branch', headerName: 'Local branch', flex: 1.5, minWidth: 90 },
  { field: 'project_name', headerName: 'Project', flex: 1, minWidth: 78 },
  { field: 'status', headerName: 'Run', flex: 0.7, minWidth: 70 },
];
const reviewTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  accentColor: '#a36bff', backgroundColor: '#11121b', foregroundColor: '#e4dfef',
  borderColor: '#2c293d', headerBackgroundColor: '#171622', headerTextColor: '#a7a1b8', fontSize: 11,
});
const nouns = { 'pull-requests': 'pull requests', issues: 'issues', 'local-branches': 'runs' };

function QueueCard({ source, item, selected, onSelect }: {
  source: ReviewsSource; item: GitHubPullRequest | GitHubIssue; selected: boolean; onSelect: () => void;
}) {
  const pullRequest = 'head' in item ? item : undefined;
  const status = pullRequest && source.pullRequestStatus(pullRequest);
  const signals = pullRequest && source.signals(item.number);
  const updatedAt = Date.parse(item.updated_at);
  const initial = item.user.login.slice(0, 1).toUpperCase();
  return <button type="button" className={`reviews-provider-card${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={onSelect}>
    <span className="reviews-provider-card-top">
      <span className="reviews-provider-number">{pullRequest ? <IconGitPullRequest size={13} /> : <IconFileText size={13} />} #{item.number}</span>
      {signals && <span className="reviews-preview-category">{signals.category}</span>}
      <span className={`reviews-provider-state${status?.tone ? ` preview-${status.tone}` : ''}`}>{status?.label ?? item.state}</span>
    </span>
    <strong>{item.title}</strong>
    <span className="reviews-provider-meta">
      <span className="reviews-provider-avatar" aria-hidden="true">{initial}</span>
      {item.user.login}
      {pullRequest && <><span aria-hidden="true">·</span>{pullRequest.head.ref} → {pullRequest.base.ref}</>}
      <span className="reviews-provider-date">{Number.isFinite(updatedAt)
        ? new Date(updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Date unavailable'}</span>
    </span>
    {signals && <span className="reviews-preview-signals">
      <span className="reviews-preview-avatar-stack" aria-label={`${signals.otherReviewers} additional reviewers`}>
        <i>{initial}</i><i>+{signals.otherReviewers}</i>
      </span>
      <i>R {signals.risk}</i><i>{signals.evidence}%</i>
      <i>CI {signals.ciPassed ? '✓' : '✕'}</i><i>Q {signals.comments}</i>
    </span>}
  </button>;
}

/** The left-hand pane: one queue of pull requests, issues, or agent-run branches with its search and filters. */
export function ReviewQueue({ source, section, items, searching, search, onSearch, filter, onFilter, selectedNumber, onSelect, onSelectRun, onNewPullRequest }: {
  source: ReviewsSource;
  section: ReviewSection;
  /** The pull requests or issues left after search and filter. */
  items: (GitHubPullRequest | GitHubIssue)[];
  searching: boolean;
  search: string;
  onSearch: (value: string) => void;
  filter: string;
  onFilter: (value: string) => void;
  selectedNumber?: number;
  onSelect: (number: number) => void;
  onSelectRun: (id: string) => void;
  onNewPullRequest: () => void;
}) {
  const local = section === 'local-branches';
  const listing = section === 'issues' ? source.issues : source.pullRequests;
  const runs = source.runs.items;
  const issueCount = (state: string) => source.issues.items.filter((item) => item.state === state).length;
  const filters = section === 'pull-requests' ? source.pullRequestFilters : [
    { value: 'all', label: `All ${source.issues.items.length}` },
    { value: 'open', label: `Open ${issueCount('open')}` }, { value: 'closed', label: `Closed ${issueCount('closed')}` },
  ];
  const total = section === 'pull-requests' ? source.pullRequestTotal
    : section === 'issues' ? (listing.loading || listing.failed ? undefined : String(listing.items.length)) : String(runs.length);
  const title = section === 'pull-requests' ? 'Pull Requests' : section === 'issues' ? 'Issues' : 'Local branches';
  const pageNote = section === 'pull-requests' ? source.pagination.note : `${total ?? 0} ${nouns[section]}`;
  return <PanelCard className="reviews-queue" withBorder>
    <PanelHeading className="reviews-panel-heading" title={total === undefined ? title : `${title} (${total})`}
      description={local ? 'Active requests and isolated agent changes' : source.project?.git_remote ?? 'GitHub project data'}
      actions={section === 'pull-requests' && <Button className="reviews-new-pr" disabled={!source.createPullRequest}
        title={source.createPullRequest ? undefined : 'Pull requests are opened by agent runs or on GitHub'}
        onClick={onNewPullRequest}><IconPlus size={13} /> New PR</Button>} />
    <div className="reviews-queue-tools">
      <TextInput
        leftSection={<IconSearch size={14} />}
        placeholder={section === 'pull-requests' ? 'Search PRs, branches, authors…' : section === 'issues' ? 'Search issues…' : 'Agent runs and branches'}
        aria-label={section === 'issues' ? 'Search issues' : section === 'pull-requests' ? 'Search pull requests' : 'Local branch diff list'}
        value={local ? '' : search}
        disabled={local}
        onChange={(event) => onSearch(event.currentTarget.value)}
      />
      <IconFilter size={16} aria-hidden="true" />
    </div>
    <div className="reviews-queue-states">{local ? <>
      <span>All {runs.length}</span>
      <span>Succeeded {runs.filter((run) => run.status === 'succeeded').length}</span>
      <span>Failed {runs.filter((run) => run.status === 'failed').length}</span>
    </> : <>
      {filters.map((item) => <button type="button" key={item.value} aria-pressed={filter === item.value}
        className={filter === item.value ? 'selected' : ''} onClick={() => onFilter(item.value)}>{item.label}</button>)}
      {listing.syncing && <span>Syncing…</span>}
    </>}</div>
    <div className="reviews-grid-wrap">
      {local ? <AgGridReact<AgentRun>
        rowData={runs} columnDefs={columns} theme={reviewTheme} getRowId={({ data }) => data.id}
        onRowClicked={({ data }) => data && onSelectRun(data.id)}
        overlayNoRowsTemplate={source.runs.failed ? 'Agent runs could not be loaded.' : 'Agent runs and local branch diffs will appear here.'}
      /> : listing.loading ? <div className="reviews-queue-empty">Loading GitHub items…</div>
        : listing.failed ? <div className="reviews-queue-empty" role="alert">GitHub data unavailable. Check the connection and try again.</div>
          : items.length ? <div className="reviews-provider-list">
            {items.map((item) => <QueueCard key={item.number} source={source} item={item}
              selected={item.number === selectedNumber} onSelect={() => onSelect(item.number)} />)}
          </div>
            : <div className="reviews-queue-empty">{searching
              ? `No ${nouns[section]} match this search.`
              : !source.project ? 'Connect a local GitHub checkout to see issues and pull requests.'
                : `No open ${nouns[section]} in this repository.`}</div>}
    </div>
    <nav className="reviews-preview-pagination" aria-label={`${title} pages`}>
      <button type="button" disabled aria-label="Previous page" title={source.pagination.reason}>‹</button>
      <button type="button" disabled aria-current="page" aria-label="Page 1 of 1" className="selected">1</button>
      <span>{pageNote}</span>
      <button type="button" disabled aria-label="Next page" title={source.pagination.reason}>›</button>
    </nav>
  </PanelCard>;
}
