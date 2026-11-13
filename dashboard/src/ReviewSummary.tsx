import { Button, Switch } from '@mantine/core';
import {
  IconAlertTriangle, IconDownload, IconFileText, IconGitBranch, IconGitMerge, IconLock, IconMinus, IconPlus, IconShieldCheck,
} from '@tabler/icons-react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { GitHubMarkdown } from './reviews-markdown';
import type { GitHubIssue, GitHubPullRequest, PullRequestView, QueueStatus, ReviewsSource } from './reviewsView';

const statTiles = [
  ['Files Changed', 'files', IconFileText], ['Lines Added', 'added', IconPlus], ['Commits', 'commits', IconGitBranch],
  ['Lines Removed', 'removed', IconMinus], ['Risk Score', 'risk', IconAlertTriangle],
  ['Evidence Completeness', 'evidence', IconShieldCheck],
] as const;

/** The right-hand pane: description, change statistics, required checks, review actions, and merge governance. */
export function ReviewSummary({ source, context, copy, view, status, pullRequest, issue, onOpenConversations, onMessage }: {
  source: ReviewsSource;
  context: string;
  copy: string;
  view: PullRequestView;
  status?: QueueStatus;
  pullRequest?: GitHubPullRequest;
  issue?: GitHubIssue;
  onOpenConversations: () => void;
  onMessage: (message: string) => void;
}) {
  return <PanelCard className="reviews-summary" withBorder>
    <PanelHeading className="reviews-panel-heading" title="Review Summary" description={context} actions={<IconShieldCheck size={17} />} />
    <GitHubMarkdown className="reviews-summary-copy reviews-markdown" value={copy} />
    <div className="reviews-summary-stats">
      {statTiles.map(([label, key, Icon]) => <div className={`reviews-preview-summary-metric ${key}`} key={label}>
        <span><Icon size={12} aria-hidden="true" />{label}</span>
        <b className={view.stats[key] === undefined ? 'reviews-unavailable-value' : undefined}>{view.stats[key] ?? 'Unavailable'}</b>
        {key === 'evidence' && view.evidencePercent !== undefined && <div className="reviews-preview-evidence-progress" role="progressbar"
          aria-label="Evidence completeness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.evidencePercent}>
          <i style={{ width: `${view.evidencePercent}%` }} />
        </div>}
      </div>)}
    </div>
    <div className="reviews-checks-heading"><b>Required checks</b><span>{view.checks?.summary ?? 'Unavailable'}</span></div>
    {view.checks ? <div className="reviews-check-empty reviews-preview-checks">
      {view.checks.items.map(([label, duration]) => <span key={label}>✓ {label}<b>{duration}</b></span>)}
    </div> : <div className="reviews-check-empty"><IconLock size={16} /> Checks and policy results need provider data.</div>}
    <div className="reviews-summary-actions">
      <div className="reviews-summary-review-actions">
        <Button color="green" disabled={!source.approve || !pullRequest}
          title={source.approve ? undefined : 'The control plane cannot approve pull requests; approve on GitHub'}
          onClick={() => pullRequest && source.approve && onMessage(source.approve(pullRequest))}>{status?.value === 'approved' ? 'Approved' : 'Approve'}</Button>
        {pullRequest && <Button color="violet" onClick={() => {
          source.requestChanges?.(pullRequest);
          onOpenConversations();
        }}>{status?.value === 'changes-requested' ? 'Changes requested' : 'Request changes'}</Button>}
        {issue && <Button variant="default" onClick={onOpenConversations}>Add comment</Button>}
      </div>
      <Button className="reviews-merge-button" disabled={!source.merge || !pullRequest} fullWidth
        title={source.merge ? undefined : 'Merging is done on GitHub; the control plane has no merge operation'}
        onClick={() => pullRequest && source.merge && onMessage(source.merge(pullRequest))}>{view.mergeLabel}</Button>
      <Button variant="default" disabled={!source.exportEvidence || !pullRequest} fullWidth
        title={source.exportEvidence ? undefined : 'The control plane holds no evidence bundle for GitHub items'}
        onClick={() => pullRequest && source.exportEvidence?.(pullRequest)}><IconDownload size={14} /> Export evidence</Button>
    </div>
    <div className="reviews-governance-heading"><IconGitMerge size={15} /><b>Merge Governance</b></div>
    <div className="reviews-governance-row"><span>Merge strategy</span><b>{view.governance.strategy ?? 'Unavailable'}</b></div>
    <div className="reviews-governance-row"><span>Target branch</span><b>{view.governance.target || 'Unavailable'}</b></div>
    <div className="reviews-governance-row"><span>Policy</span><b>{view.governance.policy ?? 'Unavailable'}</b></div>
    <div className="reviews-governance-row"><span>Auto-merge (when ready)</span><Switch size="xs" aria-label="Auto-merge when ready"
      checked={source.autoMerge?.checked ?? false} disabled={!source.autoMerge}
      title={source.autoMerge ? undefined : 'Auto-merge is configured on GitHub'}
      onChange={(event) => source.autoMerge?.set(event.currentTarget.checked)} /></div>
  </PanelCard>;
}
