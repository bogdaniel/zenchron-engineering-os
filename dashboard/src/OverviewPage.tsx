import { Badge, Progress } from '@mantine/core';
import { AreaChart, Sparkline } from '@mantine/charts';
import {
  IconActivity, IconCalendar, IconChartBar, IconChevronDown, IconCircle,
  IconCircleCheck, IconClockHour4, IconCode, IconDatabase, IconFileText, IconFileTime, IconGitBranch, IconGitPullRequest,
  IconExternalLink, IconHistory, IconInfinity, IconRobot, IconShieldCheck, IconStack2, IconTarget,
  IconInfoCircle,
} from '@tabler/icons-react';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { WorkflowOverview } from './workflows';
import type { Project } from './projects';
import type { Objective } from './objectives';
import type { AgentRun } from './agents';
import { useReportPullRequestMetrics } from './reportPullRequests';
import { useReportWorkflowRunMetrics } from './reportWorkflowRuns';

const sampleAnalytics = [
  { day: 'Jan 20', merged: 10 }, { day: 'Jan 21', merged: 18 }, { day: 'Jan 22', merged: 19 },
  { day: 'Jan 23', merged: 26 }, { day: 'Jan 24', merged: 32 }, { day: 'Jan 25', merged: 34 },
  { day: 'Jan 26', merged: 45 },
];

const sampleObjectives = [
  { title: 'Ship AI code review v2', progress: 78, status: 'On Track' },
  { title: 'Improve review velocity', progress: 62, status: 'On Track' },
  { title: 'Reduce CI cycle time', progress: 34, status: 'At Risk' },
];

type OverviewProps = {
  sampleData: boolean;
  projects: Project[] | undefined;
  projectsLoading: boolean;
  projectsError: boolean;
  objectives: Objective[] | undefined;
  objectivesLoading: boolean;
  objectivesError: boolean;
  agentRuns: AgentRun[] | undefined;
  agentRunsLoading: boolean;
  agentRunsError: boolean;
  onlineWorkers: number;
  onlineWorkerNames: string[];
  controlPlaneOnline: boolean;
};

export function OverviewPage({ sampleData, projects, projectsLoading, projectsError, objectives,
  objectivesLoading, objectivesError, agentRuns, agentRunsLoading, agentRunsError, onlineWorkers, onlineWorkerNames,
  controlPlaneOnline }: OverviewProps) {
  const pullRequests = useReportPullRequestMetrics(sampleData ? undefined : projects, 'all');
  const workflows = useReportWorkflowRunMetrics(sampleData ? undefined : projects, '30d');
  const activeObjectives = objectives?.filter((item) => item.status !== 'completed') ?? [];
  const runningAgents = agentRuns?.filter((run) => run.status === 'running').length ?? 0;
  const openPullRequests = pullRequests.outcomes.find((item) => item.name === 'Open')?.value ?? 0;
  const workflowHealth = workflows.successRate;
  const reviewableRuns = agentRuns?.filter((run) => run.diff_available) ?? [];
  const analytics = pullRequests.trend.map(({ date, merged }) => ({ day: date, merged }));
  const pullRequestDetail = projectsLoading ? 'Loading repositories'
    : projectsError ? 'Repository inventory unavailable'
      : pullRequests.githubProjectCount ? pullRequests.isLoading ? 'Loading GitHub pull-request history'
        : pullRequests.complete ? `${openPullRequests} open GitHub pull requests` : 'GitHub pull-request history unavailable'
        : 'Connect a GitHub repository';
  const workflowDetail = projectsLoading ? 'Loading repositories'
    : projectsError ? 'Repository inventory unavailable'
      : workflows.isLoading ? 'Loading GitHub Actions history'
        : workflows.completedRunCount ? `${workflows.successfulRuns} of ${workflows.completedRunCount} completed runs passed`
          : workflows.githubProjectCount ? 'No completed GitHub Actions runs in the last 30 days' : 'Connect a GitHub repository';
  return <>
    <section className="metric-grid" aria-label="Overview metrics">
      <MetricCard className="metric-card purple" label="Active Objectives" value={sampleData ? '12' : objectivesLoading ? '…' : objectivesError ? 'Unavailable' : activeObjectives.length}
        detail={sampleData ? undefined : 'Open objectives'}
        icon={<IconTarget size={19} />} trend={<MockTrend value={sampleData ? '↑ +3' : `${activeObjectives.length} open`} data={sampleData ? [0, 2, 7, 5, 8, 7, 13, 15] : [1, 8, 4, 10, 7, 11, 9, 15, 17]} />} />
      <MetricCard className="metric-card blue" label="Running Agents" value={sampleData ? '7' : agentRunsLoading ? '…' : agentRunsError ? 'Unavailable' : runningAgents}
        detail={sampleData ? undefined : `${onlineWorkers} local workers online`}
        icon={<IconRobot size={19} />} trend={<MockTrend value={sampleData ? '● Live' : `${onlineWorkers} workers`} data={sampleData ? [2, 6, 4, 9, 7, 11, 9, 12] : [1, 6, 3, 9, 7, 12, 10, 14, 13]} teal />} />
      <MetricCard className="metric-card purple pr-queue-metric" label="PR Queue" value={sampleData ? '18' : projectsLoading || pullRequests.isLoading ? '…' : pullRequests.complete ? openPullRequests : 'Unavailable'}
        detail={sampleData ? undefined : pullRequestDetail}
        icon={<IconGitPullRequest size={19} />} trend={<span className="mock-trend"><Badge>{sampleData ? '↑ +4' : pullRequests.githubProjectCount ? 'GitHub' : 'Connect GitHub'}</Badge><MockBars sampleData={sampleData} /></span>} />
      <MetricCard className="metric-card green" label="CI Health" value={sampleData ? '99.4%' : projectsLoading || workflows.isLoading ? '…' : workflowHealth === undefined ? 'Unavailable' : `${workflowHealth}%`}
        detail={sampleData ? undefined : workflowDetail}
        icon={<IconInfinity size={19} />} trend={<Badge className="mock-healthy-badge">{sampleData ? '✓ Healthy' : workflows.completedRunCount ? `${workflows.successfulRuns}/${workflows.completedRunCount} passed` : 'No CI data'}</Badge>} />
      <MetricCard className="metric-card purple" label="Budget Usage" value={sampleData ? '68%' : 'Unavailable'}
        icon={<IconDatabase size={19} />} trend={<span className="mock-budget-summary"><small>{sampleData ? '$13.6K / $20K' : 'Budgets not configured'}</small>
          <Progress className="mock-budget-progress" value={sampleData ? 68 : 0} /></span>} />
    </section>

    <div className="content-grid overview-design-preview">
      <div className="overview-top-grid">
        <WorkflowOverview designPreview={sampleData} />

        <PanelCard className="panel activity-panel" id="activity" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconActivity size={18} /></span>}
            title="Recent Activity" actions={<a className="text-link" href="#activity">All Activity <IconChevronDown size={12} /></a>} />
          <div className="activity-list">
            {sampleData ? <>
              <div><IconCircleCheck className="activity-green" size={18} /><span>PR #41827 merged to trusted-main</span><time>2m ago</time></div>
              <div><IconRobot className="activity-blue" size={18} /><span>Agent “Code Reviewer” completed run</span><time>6m ago</time></div>
              <div><IconFileText className="activity-blue" size={18} /><span>Plan approved: Add usage analytics (v1.3)</span><time>12m ago</time></div>
              <div><IconCircleCheck className="activity-green" size={18} /><span>CI passed (99.4%)</span><time>16m ago</time></div>
              <div><IconTarget className="activity-violet" size={18} /><span>Objective “Improve review velocity” updated</span><time>26m ago</time></div>
            </> : <>
              <div><IconCircleCheck className={controlPlaneOnline ? 'activity-green' : 'activity-violet'} size={18} /><span>Control plane {controlPlaneOnline ? 'is responding' : 'is unavailable'}</span><time>Live</time></div>
              {(agentRuns ?? []).slice(0, 2).map((run) => <div key={run.id}><IconRobot className="activity-blue" size={18} /><span>Agent “{run.agent_name}” {run.status}</span><time>{run.updated_at}</time></div>)}
              {onlineWorkerNames.slice(0, 2).map((name) => <div key={name}><IconRobot className="activity-blue" size={18} /><span>Worker “{name}” is online<small>Local worker heartbeat</small></span><time>Live</time></div>)}
              {(projects ?? []).slice(0, 2).map((project) => <div key={project.id}><IconGitBranch className="activity-violet" size={18} /><span>Project “{project.name}” on {project.worker_name}</span><time>Live</time></div>)}
            </>}
          </div>
        </PanelCard>
      </div>

      <div className="overview-middle-grid">
        <PanelCard className="panel objective-panel" id="objectives" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconTarget size={18} /></span>}
          title="Objective Status" actions={<a className="text-link" href="#objectives">View All →</a>} />
        <div className="preview-objective-list">{(sampleData ? sampleObjectives : activeObjectives.slice(0, 3)).map((objective) => {
          const status = sampleData ? objective.status : objective.status.replace('_', ' ');
          return <div key={objective.title}>
            <span>{objective.title}<small data-risk={status === 'At Risk' || undefined}>{status}</small></span>
            <Progress value={objective.progress} color={status === 'At Risk' ? 'yellow' : 'teal'} />
            <b>{objective.progress}%</b>
          </div>;
        })}{!sampleData && !activeObjectives.length && <div className="overview-inline-empty">{objectivesLoading ? 'Loading objectives…' : objectivesError ? 'Objectives unavailable' : 'No open objectives'}</div>}</div>
        </PanelCard>

        <PanelCard className="panel plan-panel" id="approvals" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconFileText size={18} /></span>}
          title="Plan Approvals" actions={<a className="text-link" href="#objectives">View →</a>} />
        {sampleData ? <div className="preview-approval-list">
          <div><IconFileText /><span>Add usage analytics (v1.3)</span><Badge><IconCircleCheck size={12} />Approved</Badge></div>
          <div><IconFileText /><span>Refactor agent runtime</span><Badge><IconCircleCheck size={12} />Approved</Badge></div>
          <div><IconFileTime /><span>Expand test coverage (v1.1)</span><Badge data-pending="true"><IconClockHour4 size={10} />Pending</Badge></div>
        </div> : <div className="compact-empty"><IconHistory size={18} /><span>Approval data unavailable</span><small>Approval gates are not connected yet.</small></div>}
        </PanelCard>

        <PanelCard className="panel agents-panel" id="agents" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconRobot size={18} /></span>}
          title="Agent Runs" actions={<a className="text-link" href="#agents">View →</a>} />
        {sampleData ? <div className="preview-agent-list">
          <div><IconStack2 /><span>Code Reviewer</span><Badge><span className="preview-chip-dot" />Success</Badge><time>2m ago</time></div>
          <div><IconStack2 /><span>Test Generator</span><Badge><span className="preview-chip-dot" />Success</Badge><time>4m ago</time></div>
          <div><IconShieldCheck /><span>Coverage Analyzer</span><Badge><span className="preview-chip-dot" />Success</Badge><time>7m ago</time></div>
        </div> : <div className="preview-agent-list">{(agentRuns ?? []).slice(0, 3).map((run) => <div key={run.id}>
          <IconStack2 /><span>{run.agent_name}</span><Badge data-pending={run.status !== 'succeeded' || undefined}><span className="preview-chip-dot" />{run.status}</Badge><time>{run.project_name}</time>
        </div>)}{!agentRuns?.length && <div className="overview-inline-empty">{agentRunsLoading ? 'Loading agent runs…' : agentRunsError ? 'Agent runs unavailable' : `No agent runs · ${onlineWorkers} workers online`}</div>}</div>}
        </PanelCard>

        <PanelCard className="panel evidence-panel" id="evidence" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon green-icon"><IconShieldCheck size={18} /></span>}
          title={<span className="overview-heading-with-info">Trusted-main & Evidence Health{sampleData && <IconInfoCircle className="overview-heading-info" size={14} aria-hidden="true" />}</span>} />
        <div className="evidence-health-list">
          <div><IconGitBranch size={16} /><span>Trusted-main<small>Protected · Verified · Up to date</small></span><Badge className={sampleData ? 'mock-health-tag' : 'muted-tag'}><span className="health-status-dot" aria-hidden="true" />{sampleData ? 'Healthy' : 'Unavailable'}</Badge></div>
          <div><IconStack2 size={16} /><span>Evidence<small>Artifacts · Test results · Reviews · Traces</small></span><Badge className={sampleData ? 'mock-health-tag' : 'muted-tag'}><span className="health-status-dot" aria-hidden="true" />{sampleData ? 'Healthy' : 'Unavailable'}</Badge></div>
        </div>
        </PanelCard>
      </div>

      <div className="overview-bottom-grid">
        <PanelCard className="panel review-panel preview-review-panel" id="reviews" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon violet-icon"><IconCode size={18} /></span>}
            title="Code Review" />
          {sampleData ? <>
            <div className="preview-review-meta"><b>PR #41827</b><span>Changes 8</span><span>Comments 6</span><span>Checks ✓</span>
              <Badge className="mock-approved-badge">Approved</Badge><a href="#reviews" aria-label="Open pull request review"><IconExternalLink size={14} /></a>
            </div>
            <h4>feat(review): add AI feedback signals and evidence capture</h4>
            <div className="preview-branches"><span>feature/ai-review-v2</span> → <span>trusted-main</span><b>+427 −68</b></div>
            <pre className="preview-diff"><span>128  </span><i>+ const evidence = await captureEvidence({'{'}</i>{'\n'}<span>129  </span><i>+   prNumber,</i>{'\n'}<span>130  </span><i>+   signals: feedback.signals,</i>{'\n'}<span>131  </span><i>+   artifacts: run.artifacts,</i>{'\n'}<span>132  </span><i>+ {'}' });</i></pre>
          </> : <div className="overview-review-list">{reviewableRuns.slice(0, 3).map((run) => <div key={run.id}>
            <IconGitBranch size={17} /><span>{run.project_name} · {run.branch}<small>{run.agent_name} · {run.review_comments.length} comments</small></span><Badge>{run.status}</Badge>
          </div>)}{!reviewableRuns.length && <div className="wide-empty"><IconGitPullRequest size={22} /><b>{agentRunsError ? 'Review runs unavailable' : 'No local branch diffs yet'}</b><span>{agentRunsError ? 'Check the control-plane connection.' : 'Complete an agent run to review its diff.'}</span></div>}</div>}
        </PanelCard>

        <PanelCard className="panel timeline-panel preview-timeline-panel" id="timeline" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconCalendar size={18} /></span>}
            title="Sprint Timeline" description="This Sprint (Jan 20 – Jan 27)"
            actions={<a className="text-link" href="#objectives">View Full Timeline →</a>} />
          {sampleData ? <div className="preview-timeline">
            <div className="preview-timeline-dates"><span>Jan 20</span><span>Jan 21</span><span>Jan 22</span><span>Jan 23</span><span>Jan 24</span><span>Jan 25</span><span>Jan 26</span><span>Jan 27</span></div>
            <span className="preview-today-marker" aria-label="Today"><b>Today</b></span>
            {[
              ['Plan & Approve', 1, 3, 'green', 'done'], ['Agent Implementation', 2, 5, 'purple', 'done'],
              ['Tests & Validation', 4, 6, 'blue', 'pending'], ['Review & Updates', 5, 7, 'lilac', 'pending'],
              ['Merge to Trusted-main', 7, 8, 'empty', 'pending'],
            ].map(([label, start, end, color, state]) => <div className="preview-timeline-row" key={label as string}>
              <span>{state === 'done' ? <IconCircleCheck className="preview-timeline-done" /> : <IconCircle className="preview-timeline-pending" />}{label}</span>
              <div><i className={`timeline-bar ${color}`} style={{ gridColumn: `${start} / ${end}` }} /></div>
            </div>)}
          </div> : <div className="timeline-empty"><span /><p>Create an objective to start a delivery timeline.</p></div>}
        </PanelCard>

        <PanelCard className="panel analytics-panel preview-analytics-panel" id="reports" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconChartBar size={18} /></span>}
            title="Analytics" actions={<span className="mock-analytics-filter">Delivery Velocity<IconChevronDown size={13} /></span>} />
          <div className="preview-analytics-summary overview-delivery-summary"><span>PRs Merged{sampleData ? ' (7d)' : ' (all history)'}</span><div><strong>{sampleData ? 42 : pullRequests.complete ? pullRequests.mergedCount : '—'}</strong><b>{sampleData ? '↑ +27% vs. prior 7d' : pullRequests.complete ? `${pullRequests.deliveryVelocity} / week` : 'History unavailable'}</b></div></div>
          {sampleData ? <AreaChart h={188} data={sampleAnalytics} dataKey="day" series={[{ name: 'merged', color: '#ad55ff', label: 'Merged PRs' }]}
            curveType="monotone" withDots withTooltip withGradient fillOpacity={0.4} dotProps={{ r: 3, stroke: '#f2edfa', strokeWidth: 1 }}
            gridAxis="x" tickLine="none"
            areaChartProps={{ margin: { top: 13, right: 5, bottom: 0, left: 5 } }}
            xAxisProps={{ height: 21, interval: 0, tickMargin: 0, padding: { left: 10, right: 0 } }}
            yAxisProps={{ width: 25, domain: [0, 50], ticks: [0, 10, 20, 30, 40, 50], interval: 0 }} /> : pullRequests.complete && pullRequests.mergedCount > 0 ? <div role="img" aria-label="Merged pull requests by period"><AreaChart h={188} data={analytics} dataKey="day" series={[{ name: 'merged', color: '#ad55ff', label: 'Merged PRs' }]}
            curveType="monotone" withDots withTooltip withGradient fillOpacity={0.4} dotProps={{ r: 3, stroke: '#f2edfa', strokeWidth: 1 }} gridAxis="x" tickLine="none" /></div>
            : <div className="chart-empty"><IconChartBar size={23} /><span>{projectsLoading || pullRequests.isLoading ? 'Loading pull-request history…' : 'No delivery data yet'}</span><small>{projectsError || pullRequests.isError ? 'GitHub history unavailable.' : 'Connect a GitHub repository to view delivery.'}</small></div>}
        </PanelCard>
      </div>
    </div>
    <footer className="page-footer"><span>ZENCHRON ENGINEERING</span><span>{sampleData ? 'Design preview · sample data' : 'Control plane · live data'}</span></footer>
  </>;
}

function MockTrend({ value, data, teal = false }: { value: string; data: number[]; teal?: boolean }) {
  return <span className="mock-trend"><Badge data-teal={teal || undefined}>{value}</Badge>
    <Sparkline data={data} color={teal ? 'teal.4' : 'violet.5'} w={98} h={32} curveType="monotone"
      areaProps={{ dot: { r: 2.5, fill: '#f2edfa', stroke: teal ? '#5eead4' : '#c394ff', strokeWidth: 1 } }} /></span>;
}

function MockBars({ sampleData }: { sampleData: boolean }) {
  return <span className="mock-bars" aria-hidden="true">{(sampleData ? [8, 14, 18, 23, 28] : [8, 14, 11, 20, 27]).map((height) => <i key={height} style={{ height }} />)}</span>;
}
