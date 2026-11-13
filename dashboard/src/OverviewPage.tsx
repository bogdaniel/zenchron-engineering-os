import { Badge, Menu, Modal, Progress } from '@mantine/core';
import { Fragment, useState } from 'react';
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
import { mockOverview } from './overview-preview-data';
import { useLiveOverview } from './overviewView';
import type { OverviewActivity, OverviewLiveData } from './overviewView';

export function OverviewPage({ sampleData, ...liveData }: OverviewLiveData & { sampleData: boolean }) {
  const live = useLiveOverview(liveData, !sampleData);
  const source = sampleData ? mockOverview : live;
  const { kpis, health, review, timeline } = source;
  const [activityOpen, setActivityOpen] = useState(false);
  const [analyticsLabel, setAnalyticsLabel] = useState(source.analytics[0].label);
  const analytics = source.analytics.find(({ label }) => label === analyticsLabel) ?? source.analytics[0];
  const activityRows = (rows: OverviewActivity[]) => rows.map((row) => <div key={row.key}>
    {row.icon}<span>{row.text}</span><time>{row.time}</time>
  </div>);
  return <>
    <section className="metric-grid" aria-label="Overview metrics">
      <MetricCard className="metric-card purple" label="Active Objectives" value={kpis.objectives.value} detail={kpis.objectives.detail}
        icon={<IconTarget size={19} />} trend={<KpiTrend badge={kpis.objectives.badge} points={kpis.objectives.points} />} />
      <MetricCard className="metric-card blue" label="Running Agents" value={kpis.agents.value} detail={kpis.agents.detail}
        icon={<IconRobot size={19} />} trend={<KpiTrend badge={kpis.agents.badge} points={kpis.agents.points} teal />} />
      <MetricCard className="metric-card purple pr-queue-metric" label="PR Queue" value={kpis.pullRequests.value} detail={kpis.pullRequests.detail}
        icon={<IconGitPullRequest size={19} />} trend={<span className="mock-trend"><Badge>{kpis.pullRequests.badge}</Badge>
          {kpis.pullRequests.bars && <span className="mock-bars" aria-hidden="true">
            {kpis.pullRequests.bars.map((height) => <i key={height} style={{ height }} />)}</span>}</span>} />
      <MetricCard className="metric-card green" label="CI Health" value={kpis.ci.value} detail={kpis.ci.detail}
        icon={<IconInfinity size={19} />} trend={<Badge className="mock-healthy-badge">{kpis.ci.badge}</Badge>} />
      <MetricCard className="metric-card purple" label="Budget Usage" value={kpis.budget.value}
        icon={<IconDatabase size={19} />} trend={<span className="mock-budget-summary"><small>{kpis.budget.summary}</small>
          <Progress className="mock-budget-progress" value={kpis.budget.percent} /></span>} />
    </section>

    <div className="content-grid overview-design-preview">
      <div className="overview-top-grid">
        <WorkflowOverview designPreview={sampleData} />

        <PanelCard className="panel activity-panel" id="activity" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconActivity size={18} /></span>}
            title="Recent Activity" actions={<button type="button" className="text-link"
              onClick={() => setActivityOpen(true)}>All Activity <IconChevronDown size={12} /></button>} />
          <div className="activity-list">{activityRows(source.activity)}</div>
        </PanelCard>
        <Modal opened={activityOpen} onClose={() => setActivityOpen(false)} title="All Activity" centered size="lg">
          <div className="activity-list activity-dialog-list">{activityRows(source.allActivity)}</div>
        </Modal>
      </div>

      <div className="overview-middle-grid">
        <PanelCard className="panel objective-panel" id="objectives" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconTarget size={18} /></span>}
          title="Objective Status" actions={<a className="text-link" href="#objectives">View All →</a>} />
        <div className="preview-objective-list">{source.objectives.map((objective) => <div key={objective.key}>
          <span>{objective.title}<small data-risk={objective.atRisk || undefined}>{objective.status}</small></span>
          <Progress value={objective.progress} color={objective.atRisk ? 'yellow' : 'teal'} />
          <b>{objective.progress}%</b>
        </div>)}{!source.objectives.length && <div className="overview-inline-empty">{source.objectivesEmpty}</div>}</div>
        </PanelCard>

        <PanelCard className="panel plan-panel" id="approvals" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconFileText size={18} /></span>}
          title="Plan Approvals" actions={<a className="text-link" href="#objectives">View →</a>} />
        {source.approvalsEmpty ? <div className="compact-empty"><IconHistory size={18} /><span>{source.approvalsEmpty.title}</span>
          <small>{source.approvalsEmpty.note}</small></div>
          : <div className="preview-approval-list">{source.approvals.map((approval) => <div key={approval.title}>
            {approval.pending ? <IconFileTime /> : <IconFileText />}<span>{approval.title}</span>
            {approval.pending ? <Badge data-pending="true"><IconClockHour4 size={10} />Pending</Badge>
              : <Badge><IconCircleCheck size={12} />Approved</Badge>}
          </div>)}</div>}
        </PanelCard>

        <PanelCard className="panel agents-panel" id="agents" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconRobot size={18} /></span>}
          title="Agent Runs" actions={<a className="text-link" href="#agents">View →</a>} />
        <div className="preview-agent-list">{source.agentRuns.map((run) => <div key={run.key}>
          {run.icon}<span>{run.name}{run.detail && <small>{run.detail}</small>}</span>
          <Badge data-pending={run.pending || undefined}><span className="preview-chip-dot" />{run.status}</Badge><time>{run.time}</time>
        </div>)}{!source.agentRuns.length && <div className="overview-inline-empty">{source.agentRunsEmpty}</div>}</div>
        </PanelCard>

        <PanelCard className="panel evidence-panel" id="evidence" withBorder>
        <PanelHeading className="panel-heading" icon={<span className="section-icon green-icon"><IconShieldCheck size={18} /></span>}
          title={<span className="overview-heading-with-info">Trusted-main & Evidence Health<IconInfoCircle className="overview-heading-info" size={14} aria-hidden="true" /></span>} />
        <div className="evidence-health-list">
          {([[IconGitBranch, 'Trusted-main', health.trustedMain], [IconStack2, 'Evidence', health.evidence]] as const).map(([Icon, name, detail]) => <div key={name}>
            <Icon size={16} /><span>{name}<small>{detail}</small></span>
            <Badge className={health.healthy ? 'mock-health-tag' : 'muted-tag'}><span className="health-status-dot" aria-hidden="true" />{health.status}</Badge>
          </div>)}
        </div>
        </PanelCard>
      </div>

      <div className="overview-bottom-grid">
        <PanelCard className="panel review-panel preview-review-panel" id="reviews" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon violet-icon"><IconCode size={18} /></span>}
            title="Code Review" />
          {review ? <>
            <div className="preview-review-meta"><b>{review.id}</b>{review.chips.map((chip) => <span key={chip}>{chip}</span>)}
              <Badge className="mock-approved-badge" data-pending={review.pending || undefined}>{review.status}</Badge>
              <a href="#reviews" aria-label="Open in Reviews"><IconExternalLink size={14} /></a>
            </div>
            <h4>{review.title}</h4>
            <div className="preview-branches"><span>{review.from}</span> → <span>{review.to}</span>{review.stat && <b>{review.stat}</b>}</div>
            <pre className="preview-diff">{review.diff.map((line, index) => <Fragment key={index}>
              {index > 0 && '\n'}{line.number !== undefined && <span>{`${line.number}  `}</span>}<i>{line.text}</i>
            </Fragment>)}</pre>
          </> : <div className="wide-empty"><IconGitPullRequest size={22} /><b>{source.reviewEmpty.title}</b><span>{source.reviewEmpty.note}</span></div>}
        </PanelCard>

        <PanelCard className="panel timeline-panel preview-timeline-panel" id="timeline" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconCalendar size={18} /></span>}
            title="Sprint Timeline" description={timeline.description}
            actions={<a className="text-link" href="#objectives">View Full Timeline →</a>} />
          {timeline.sprint ? <div className="preview-timeline">
            <div className="preview-timeline-dates">{timeline.sprint.dates.map((date) => <span key={date}>{date}</span>)}</div>
            <span className="preview-today-marker" aria-label="Today"><b>Today</b></span>
            {timeline.sprint.rows.map(([label, start, end, color, state]) => <div className="preview-timeline-row" key={label}>
              <span>{state === 'done' ? <IconCircleCheck className="preview-timeline-done" /> : <IconCircle className="preview-timeline-pending" />}{label}</span>
              <div><i className={`timeline-bar ${color}`} style={{ gridColumn: `${start} / ${end}` }} /></div>
            </div>)}
          </div> : <div className="timeline-empty"><span /><p>{timeline.empty}</p></div>}
        </PanelCard>

        <PanelCard className="panel analytics-panel preview-analytics-panel" id="reports" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconChartBar size={18} /></span>}
            title="Analytics" actions={<Menu position="bottom-end" withinPortal>
              <Menu.Target><button className="mock-analytics-filter" type="button" aria-label="Choose analytics metric">
                {analytics.label}<IconChevronDown size={13} /></button></Menu.Target>
              <Menu.Dropdown>{source.analytics.map(({ label }) => <Menu.Item key={label}
                onClick={() => setAnalyticsLabel(label)}>{label}</Menu.Item>)}
                <Menu.Divider /><Menu.Item component="a" href="#reports">Open Reports</Menu.Item></Menu.Dropdown>
            </Menu>} />
          <div className="preview-analytics-summary"><span>{analytics.summary}</span><div><strong>{analytics.value}</strong><b>{analytics.delta}</b></div></div>
          {analytics.empty ? <div className="chart-empty"><IconChartBar size={23} /><span>{analytics.empty.title}</span><small>{analytics.empty.note}</small></div>
            : <AreaChart role="img" aria-label={analytics.chartLabel} h={188} data={analytics.points} dataKey="day"
              series={[{ name: 'value', color: '#ad55ff', label: analytics.seriesLabel }]}
              curveType="monotone" withDots withTooltip withGradient fillOpacity={0.4} dotProps={{ r: 3, stroke: '#f2edfa', strokeWidth: 1 }}
              gridAxis="x" tickLine="none"
              areaChartProps={{ margin: { top: 13, right: 5, bottom: 0, left: 5 } }}
              xAxisProps={{ height: 21, interval: analytics.yAxis ? 0 : 'preserveStartEnd', tickMargin: 0, padding: { left: 10, right: 0 } }}
              yAxisProps={{ width: 25, ...analytics.yAxis }} />}
        </PanelCard>
      </div>
    </div>
    <footer className="page-footer"><span>ZENCHRON ENGINEERING</span><span>{source.footer}</span></footer>
  </>;
}

function KpiTrend({ badge, points, teal = false }: { badge: string; points?: number[]; teal?: boolean }) {
  return <span className="mock-trend"><Badge data-teal={teal || undefined}>{badge}</Badge>
    {points && <Sparkline data={points} color={teal ? 'teal.4' : 'violet.5'} w={98} h={32} curveType="monotone"
      areaProps={{ dot: { r: 2.5, fill: '#f2edfa', stroke: teal ? '#5eead4' : '#c394ff', strokeWidth: 1 } }} />}</span>;
}
