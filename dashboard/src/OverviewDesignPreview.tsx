import { Badge, Progress } from '@mantine/core';
import { AreaChart, Sparkline } from '@mantine/charts';
import {
  IconActivity, IconCalendar, IconChartBar, IconChevronDown, IconCircle,
  IconCircleCheck, IconCode, IconCoins, IconFileText, IconGitBranch, IconGitPullRequest,
  IconExternalLink, IconHistory, IconRobot, IconShieldCheck, IconTarget,
} from '@tabler/icons-react';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { WorkflowOverview } from './workflows';

const analytics = [
  { day: 'Jan 20', merged: 10 }, { day: 'Jan 21', merged: 18 }, { day: 'Jan 22', merged: 19 },
  { day: 'Jan 23', merged: 26 }, { day: 'Jan 24', merged: 32 }, { day: 'Jan 25', merged: 34 },
  { day: 'Jan 26', merged: 42 },
];

const objectives = [
  { title: 'Ship AI code review v2', progress: 78, status: 'On Track' },
  { title: 'Improve review velocity', progress: 62, status: 'On Track' },
  { title: 'Reduce CI cycle time', progress: 34, status: 'At Risk' },
];

export function OverviewDesignPreview() {
  return <>
    <section className="metric-grid" aria-label="Overview mock metrics">
      <MetricCard className="metric-card purple" label="Active Objectives" value="12"
        icon={<IconTarget size={19} />} trend={<MockTrend value="+3" data={[3, 4, 3, 6, 5, 7, 9]} />} />
      <MetricCard className="metric-card blue" label="Running Agents" value="7"
        icon={<IconRobot size={19} />} trend={<MockTrend value="Live" data={[3, 4, 4, 6, 5, 7, 8]} teal />} />
      <MetricCard className="metric-card purple pr-queue-metric" label="PR Queue" value="18"
        icon={<IconGitPullRequest size={19} />} trend={<span className="mock-trend"><Badge>+4</Badge><MockBars /></span>} />
      <MetricCard className="metric-card green" label="CI Health" value="99.4%"
        icon={<IconActivity size={19} />} trend={<Badge className="mock-healthy-badge">✓ Healthy</Badge>} />
      <MetricCard className="metric-card purple" label="Budget Usage" value="68%"
        icon={<IconCoins size={19} />} trend={<span className="mock-budget-summary"><small>$13.6K / $20K</small>
          <Progress className="mock-budget-progress" value={68} /></span>} />
    </section>

    <div className="content-grid overview-design-preview">
      <div className="overview-top-grid">
        <WorkflowOverview designPreview />

        <PanelCard className="panel activity-panel" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconActivity size={18} /></span>}
            title="Recent Activity" actions={<a className="text-link" href="#activity">All activity ⌄</a>} />
          <div className="activity-list">
            <div><IconCircleCheck className="activity-green" size={17} /><span>PR #41827 merged to trusted-main</span><time>2m ago</time></div>
            <div><IconRobot className="activity-blue" size={17} /><span>Agent “Code Reviewer” completed run</span><time>6m ago</time></div>
            <div><IconCode className="activity-blue" size={17} /><span>Plan approved: Add usage analytics (v1.3)</span><time>12m ago</time></div>
            <div><IconCircleCheck className="activity-green" size={17} /><span>CI passed (99.4%)</span><time>16m ago</time></div>
            <div><IconTarget className="activity-violet" size={17} /><span>Objective “Improve review velocity” updated</span><time>26m ago</time></div>
          </div>
        </PanelCard>
      </div>

      <div className="overview-middle-grid">
        <PanelCard className="panel objective-panel" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconTarget size={18} /></span>}
          title="Objective Status" actions={<a className="text-link" href="#objectives">View All →</a>} />
        <div className="preview-objective-list">{objectives.map((objective) => <div key={objective.title}>
          <span>{objective.title}<small data-risk={objective.status === 'At Risk' || undefined}>{objective.status}</small></span>
          <Progress value={objective.progress} color={objective.status === 'At Risk' ? 'yellow' : 'teal'} />
          <b>{objective.progress}%</b>
        </div>)}</div>
        </PanelCard>

        <PanelCard className="panel plan-panel" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconFileText size={18} /></span>}
          title="Plan Approvals" actions={<a className="text-link" href="#objectives">View →</a>} />
        <div className="preview-approval-list">
          <div><IconFileText /><span>Add usage analytics (v1.3)</span><Badge>Approved</Badge></div>
          <div><IconFileText /><span>Refactor agent runtime</span><Badge>Approved</Badge></div>
          <div><IconHistory /><span>Expand test coverage (v1.1)</span><Badge data-pending="true">Pending</Badge></div>
        </div>
        </PanelCard>

        <PanelCard className="panel agents-panel" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon blue-icon"><IconRobot size={18} /></span>}
          title="Agent Runs" actions={<a className="text-link" href="#agents">View →</a>} />
        <div className="preview-agent-list">
          <div><IconCode /><span>Code Reviewer</span><Badge>Success</Badge></div>
          <div><IconRobot /><span>Test Generator</span><Badge>Success</Badge></div>
          <div><IconActivity /><span>Coverage Analyzer</span><Badge>Success</Badge></div>
        </div>
        </PanelCard>

        <PanelCard className="panel evidence-panel" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon green-icon"><IconShieldCheck size={18} /></span>}
          title="Trusted-main & Evidence Health" />
        <div className="evidence-health-list">
          <div><IconGitBranch size={16} /><span>Trusted-main<small>Protected · Verified · Up to date</small></span><Badge className="mock-health-tag">Healthy</Badge></div>
          <div><IconShieldCheck size={16} /><span>Evidence<small>Artifacts · Test results · Reviews · Traces</small></span><Badge className="mock-health-tag">Healthy</Badge></div>
        </div>
        </PanelCard>
      </div>

      <div className="overview-bottom-grid">
        <PanelCard className="panel review-panel preview-review-panel" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon violet-icon"><IconCode size={18} /></span>}
            title="Code Review" />
          <div className="preview-review-meta"><b>PR #41827</b><span>Changes 8</span><span>Comments 6</span><span>Checks ✓</span>
            <Badge className="mock-approved-badge">Approved</Badge><a href="#reviews" aria-label="Open pull request review"><IconExternalLink size={14} /></a>
          </div>
          <h4>feat(review): add AI feedback signals and evidence capture</h4>
          <div className="preview-branches"><span>feature/ai-review-v2</span> → <span>trusted-main</span><b>+427 −68</b></div>
          <pre className="preview-diff"><span>128  </span><i>+ const evidence = await captureEvidence({'{'}</i>{'\n'}<span>129  </span><i>+   prNumber,</i>{'\n'}<span>130  </span><i>+   signals: feedback.signals,</i>{'\n'}<span>131  </span><i>+   artifacts: run.artifacts,</i>{'\n'}<span>132  </span><i>+ {'}' });</i></pre>
        </PanelCard>

        <PanelCard className="panel timeline-panel preview-timeline-panel" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon blue-icon"><IconCalendar size={18} /></span>}
            title="Sprint Timeline" description="This Sprint (Jan 20 – Jan 27)"
            actions={<a className="text-link" href="#objectives">View Full Timeline →</a>} />
          <div className="preview-timeline">
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
          </div>
        </PanelCard>

        <PanelCard className="panel analytics-panel preview-analytics-panel" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconChartBar size={18} /></span>}
            title="Analytics" actions={<span className="mock-analytics-filter">Delivery Velocity<IconChevronDown size={13} /></span>} />
          <div className="preview-analytics-summary"><strong>42</strong><span>PRs merged (7d)</span><b>↑ +27% vs. prior 7d</b></div>
          <AreaChart h={188} data={analytics} dataKey="day" series={[{ name: 'merged', color: '#ad55ff', label: 'Merged PRs' }]}
            curveType="monotone" withDots withTooltip withGradient fillOpacity={0.4} dotProps={{ r: 3, stroke: '#f2edfa', strokeWidth: 1 }}
            gridAxis="x" tickLine="none"
            areaChartProps={{ margin: { top: 45, right: 5, bottom: 0, left: 5 } }}
            xAxisProps={{ height: 21, interval: 0, tickMargin: 0, padding: { left: 10, right: 0 } }}
            yAxisProps={{ width: 25, domain: [0, 50], ticks: [0, 10, 20, 30, 40, 50], interval: 0 }} />
        </PanelCard>
      </div>
    </div>
    <footer className="page-footer"><span>ZENCHRON ENGINEERING</span><span>Design preview · sample data</span></footer>
  </>;
}

function MockTrend({ value, data, teal = false }: { value: string; data: number[]; teal?: boolean }) {
  return <span className="mock-trend"><Badge data-teal={teal || undefined}>{value}</Badge>
    <Sparkline data={data} color={teal ? 'teal.4' : 'violet.5'} w={58} h={24} /></span>;
}

function MockBars() {
  return <span className="mock-bars" aria-hidden="true">{[8, 13, 11, 18, 24].map((height) => <i key={height} style={{ height }} />)}</span>;
}
