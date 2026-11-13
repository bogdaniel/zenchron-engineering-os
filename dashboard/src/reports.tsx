import { useState } from 'react';
import { AreaChart, BarChart, CompositeChart, DonutChart, Sparkline } from '@mantine/charts';
import { Button, Select } from '@mantine/core';
import {
  IconActivity, IconCalendar, IconChartBar, IconChevronDown, IconCircleCheck, IconCode, IconCpu, IconFilter, IconInfinity,
  IconMessageCircle, IconRocket, IconRoute, IconSparkles, IconStack, IconStopwatch, IconUsers,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { DownloadableReports } from './DownloadableReports';
import { MetricCard } from './MetricCard';
import type { Objective } from './objectives';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import type { Project } from './projects';
import { ProductSummaryPanel, WorkspaceSummaryPanel } from './ReportSummaries';
import { ChartLegend, ReportOutcomeLegend, UnavailableChart } from './ReportVisuals';
import { mockReports } from './reports-preview';
import {
  defaultScope, latencyPercentiles, timeRanges, useLiveReports, type LatencyPercentile, type ReportScope, type ReportsSource,
} from './reportsView';
import './reports.css';
import './reports-preview.css';

interface ReportsPageProps {
  designPreview?: boolean;
  apiOnline: boolean;
  objectives: Objective[] | undefined;
  projects: Project[] | undefined;
  workers: { status: 'online' | 'offline' }[] | undefined;
}

const insightViews = [
  { value: 'executive', label: 'Executive Summary' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'execution', label: 'Execution' },
  { value: 'objectives', label: 'Objectives' },
];
const metricCards: { key: keyof ReportsSource['metrics']; tone: string; label: string; detail: string; icon: ReactNode; color: string }[] = [
  { key: 'velocity', tone: 'velocity', label: 'Delivery Velocity', detail: 'PRs / week', icon: <IconRocket size={17} />, color: 'violet.5' },
  { key: 'cycleTime', tone: 'cycle-time', label: 'Cycle Time', detail: 'Hours', icon: <IconStopwatch size={17} />, color: 'teal.4' },
  { key: 'ciDuration', tone: 'ci-duration', label: 'CI Duration', detail: 'Avg. minutes', icon: <IconStack size={17} />, color: 'teal.5' },
  { key: 'reviewLatency', tone: 'review-latency', label: 'Review Latency', detail: 'Hours', icon: <IconMessageCircle size={17} />, color: 'violet.5' },
  { key: 'agentSpend', tone: 'agent-spend', label: 'Agent Spend', detail: 'USD', icon: <IconCpu size={17} />, color: 'violet.5' },
  { key: 'acceptance', tone: 'acceptance-rate', label: 'Acceptance Rate', detail: 'Closed pull requests', icon: <IconCircleCheck size={17} />, color: 'teal.5' },
  { key: 'autonomy', tone: 'autonomous-completion', label: 'Autonomous Completion', detail: 'Completed agent runs', icon: <IconInfinity size={17} />, color: 'teal.5' },
];
const chevron = <IconChevronDown size={12} aria-hidden="true" />;
const axisTick = { fill: '#9691a8', fontSize: 8 };
// Every date is labelled while the labels fit; a twelve-period trend keeps only the ends and what fits between.
const dateLabels = (points: unknown[]) => points.length <= 11 ? 0 : 'preserveStartEnd' as const;

export function ReportsPage({ designPreview = false, ...facts }: ReportsPageProps) {
  const [scope, setScope] = useState(defaultScope);
  const [appliedScope, setAppliedScope] = useState(defaultScope);
  const [insightView, setInsightView] = useState('executive');
  const [latencyPercentile, setLatencyPercentile] = useState<LatencyPercentile>('P50');
  const live = useLiveReports(!designPreview, facts, appliedScope);
  const source = designPreview ? mockReports(appliedScope, latencyPercentile) : live;
  const { options, delivery, ci, outcomes, latency, spend, acceptance } = source;
  const updateScope = (key: keyof ReportScope, value: string | null) => {
    setScope((current) => ({ ...current, [key]: value ?? 'all' }));
  };
  const appliedLabel = (key: keyof ReportScope, choices: { value: string; label: string }[]) =>
    appliedScope[key] !== defaultScope[key] && choices.find(({ value }) => value === appliedScope[key])?.label;
  const scopeDescription = [
    appliedLabel('timeRange', timeRanges), appliedLabel('product', options.products),
    appliedLabel('objectiveOwner', options.teams), appliedLabel('workflow', options.workflows),
    appliedLabel('repository', options.repositories),
  ].filter(Boolean).join(' · ');
  const autonomyLegend = { tone: 'teal', label: source.autonomyRecorded ? 'Autonomous completion rate' : 'Autonomous completion · unavailable' };
  const ciScale = ci.yAxis?.domain[1] ?? Math.max(...ci.points.map((point) => point.runs));
  const visibleInsights = source.insights.filter((insight) => insightView === 'executive' || insight.group === insightView);

  return (
    <section className="reports-page reports-design-preview" data-preview={designPreview ? 'mock' : undefined}>
      <div className="reports-scope-bar" aria-label="Report scope">
        <div className="reports-scope-label"><IconFilter size={16} /><span>Report Scope</span></div>
        <Select aria-label="Time Range" label="Time Range" data={timeRanges} rightSection={chevron}
          rightSectionPointerEvents="none" leftSection={<IconCalendar size={13} />} value={scope.timeRange}
          onChange={(value) => updateScope('timeRange', value)} />
        <Select aria-label="Product" label="Product" data={options.products} rightSection={chevron}
          rightSectionPointerEvents="none" leftSection={<IconStack size={13} />} value={scope.product}
          onChange={(value) => updateScope('product', value)} />
        <Select aria-label="Team" label="Team" data={options.teams} value={scope.objectiveOwner}
          rightSection={chevron} rightSectionPointerEvents="none"
          leftSection={<IconUsers size={13} />} onChange={(value) => updateScope('objectiveOwner', value)} />
        <Select aria-label={source.workflowUnavailable ?? 'Workflow'} title={source.workflowUnavailable}
          label="Workflow" leftSection={<IconRoute size={13} />} data={options.workflows} rightSection={chevron}
          rightSectionPointerEvents="none" disabled={source.workflowUnavailable !== undefined}
          value={scope.workflow} onChange={(value) => updateScope('workflow', value)} />
        <Select aria-label="Repository" label="Repository" data={options.repositories}
          rightSection={chevron} rightSectionPointerEvents="none"
          leftSection={<IconCode size={13} />} value={scope.repository} onChange={(value) => updateScope('repository', value)} />
        <div className="reports-scope-actions">
          <Button className="reports-apply-filters" onClick={() => setAppliedScope(scope)}>Apply Filters</Button>
          <Button className="reports-reset-filters" variant="subtle" onClick={() => {
            setScope(defaultScope);
            setAppliedScope(defaultScope);
          }}>Reset</Button>
        </div>
      </div>
      {scopeDescription && <p className="reports-preview-scope-status" role="status">
        {source.scopeAppliedLabel}: {scopeDescription}
      </p>}

      <div className="reports-metrics" aria-label="Workspace metrics">
        {metricCards.map(({ key, tone, label, detail, icon, color }) => {
          const { value, delta, sparkline } = source.metrics[key];
          return <MetricCard key={key} className={`reports-metric ${tone}`} label={label} detail={detail} icon={icon}
            value={delta ? <span className="reports-preview-value">{value}<small>{delta}</small></span> : value ?? 'Unavailable'}
            trend={sparkline?.some((point) => point !== null)
              ? <Sparkline className="metric-sparkline" role="img" aria-label={`${label} trend`} data={sparkline} color={color}
                w={54} h={24} withGradient={false} strokeWidth={2} /> : undefined} />;
        })}
      </div>

      <div className="reports-content-grid">
        <PanelCard className="reports-panel delivery-velocity-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconChartBar size={15} />}
            title="Delivery Velocity &amp; Cycle Time" />
          <ChartLegend items={[{ tone: 'violet', label: 'Delivery Velocity (PRs/week)' }, { tone: 'teal', label: 'Cycle Time (hours)' }]} />
          {delivery.empty ? <UnavailableChart detail={delivery.empty} /> : <CompositeChart
            className="reports-pull-request-chart"
            h={128}
            textColor="#9691a8"
            data={delivery.points}
            dataKey="date"
            series={[
              { name: 'cycle', label: 'Cycle Time (hours)', color: 'teal.4', type: 'area', yAxisId: 'right' },
              { name: 'merged', label: 'Delivery Velocity (PRs/week)', color: 'violet.5', type: 'area' },
            ]}
            areaProps={{ fillOpacity: 0.14 }}
            withRightYAxis
            withLegend={false}
            xAxisProps={{ tick: { fill: '#9691a8', fontSize: 9 }, interval: 'preserveStartEnd' }}
            yAxisProps={{ tick: { fill: '#9691a8', fontSize: 9 }, width: 28 }}
            rightYAxisProps={{ tick: { fill: '#9691a8', fontSize: 9 }, width: 30 }}
            yAxisLabel="PRs / week"
            rightYAxisLabel="Cycle time (h)"
            gridAxis="xy"
            strokeWidth={2}
            withDots
            withTooltip
            aria-label={delivery.label}
          />}
        </PanelCard>
        <PanelCard className="reports-panel ci-distribution-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconActivity size={15} />} title="CI Duration Distribution"
            actions={ci.percentiles && <div className="reports-percentiles" role="group" aria-label="CI duration percentiles">
              <span>p50 {ci.percentiles.p50}m</span>
              <span>p95 {ci.percentiles.p95}m</span>
            </div>} />
          {ci.empty ? <UnavailableChart detail={ci.empty} /> : <BarChart
            className="reports-ci-chart"
            h={112}
            textColor="#9691a8"
            data={ci.points}
            dataKey="duration"
            series={[{ name: 'runs', label: 'Completed runs', color: 'teal.5' }]}
            yAxisLabel="Runs"
            yAxisProps={{ ...ci.yAxis, tick: axisTick, width: 30, allowDecimals: false,
              tickFormatter: (value: number) => value >= 1000 ? `${value / 1000}K` : `${value}` }}
            withLegend={false}
            getBarColor={(value) => value >= ciScale * 0.6 ? '#27d9a3' : value >= ciScale * 0.4 ? '#43c7af'
              : value >= ciScale * 0.2 ? '#8b54e8' : '#5631a3'}
            xAxisProps={{ tick: axisTick, interval: 0 }}
            gridAxis="y"
            withTooltip
            aria-label={ci.label}
          />}
          <span className="reports-ci-axis-title" aria-hidden="true">CI Duration (minutes)</span>
        </PanelCard>

        <PanelCard className="reports-panel work-outcomes-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconRoute size={15} />}
            title={<>Work Outcomes <small>({outcomes.caption})</small></>} />
          {outcomes.message ? <div className="reports-empty" role="status">{outcomes.message}</div>
            : <div className={`reports-outcomes-layout${outcomes.empty ? ' reports-outcomes-empty' : ''}`}>
              {outcomes.empty ? <div className="reports-empty" role="status">{outcomes.empty}</div>
                : <div className="reports-outcomes-donut">
                  <DonutChart size={120} thickness={15} data={outcomes.sections} aria-label={outcomes.label} />
                  <div className="reports-outcomes-label" aria-hidden="true"><b>{outcomes.total}</b><span>{outcomes.unit}</span></div>
                </div>}
              <ReportOutcomeLegend items={outcomes.legend} valueSuffix={outcomes.valueSuffix} label={outcomes.legendLabel} />
            </div>}
        </PanelCard>
        <PanelCard className="reports-panel review-latency-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconMessageCircle size={15} />} title="Review Latency Trend"
            actions={<div className="reports-percentiles" role="group" aria-label={latency.groupLabel}>
              {latencyPercentiles.map((percentile) =>
                <button key={percentile} type="button" aria-pressed={latencyPercentile === percentile}
                  disabled={latency.empty !== undefined} title={latency.empty}
                  onClick={() => setLatencyPercentile(percentile)}>{percentile}</button>)}
            </div>} />
          <ChartLegend items={[{ tone: 'violet', label: 'Review latency' }]} />
          {latency.empty ? <UnavailableChart detail={latency.empty} />
            : <AreaChart className="reports-latency-chart" h={76} textColor="#9691a8"
              data={latency.points} dataKey="date" series={[{ name: 'latency', label: latency.seriesLabel, color: 'violet.5' }]}
              yAxisProps={{ ...latency.yAxis, tickFormatter: (value) => `${value}h`, tick: axisTick, width: 28 }}
              xAxisProps={{ tick: axisTick, interval: dateLabels(latency.points) }}
              gridAxis="xy" withDots withTooltip aria-label={latency.label} />}
        </PanelCard>
        <PanelCard className="reports-panel agent-spend-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconCpu size={15} />} title="Agent Spend" />
          <ChartLegend items={[{ tone: 'violet', label: 'Spend (USD)' }, autonomyLegend]} />
          {spend.empty ? <UnavailableChart detail={spend.empty} />
            : <CompositeChart className="reports-spend-chart" h={76} textColor="#9691a8"
              data={spend.points} dataKey="date" series={[
                { name: 'spend', label: 'Spend (USD)', color: 'violet.5', type: 'bar' },
                ...(source.autonomyRecorded ? [{
                  name: 'autonomy', label: 'Autonomous completion rate', color: 'teal.4', type: 'line' as const, yAxisId: 'right',
                }] : []),
              ]}
              withRightYAxis={source.autonomyRecorded} withLegend={false}
              xAxisProps={{ tick: axisTick, interval: dateLabels(spend.points) }}
              yAxisProps={{ ...spend.yAxis, tickFormatter: spend.tick, tick: axisTick, width: 34 }}
              rightYAxisProps={{ ...spend.rightYAxis, tickFormatter: (value: number) => `${value}%`, tick: axisTick, width: 30 }}
              gridAxis="xy" withDots withTooltip aria-label={spend.label} />}
        </PanelCard>
        <PanelCard className="reports-panel acceptance-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconCircleCheck size={15} />}
            title="Acceptance &amp; Autonomous Completion" />
          <ChartLegend items={[{ tone: 'violet', label: 'Acceptance rate' }, autonomyLegend]} />
          {acceptance.empty ? <UnavailableChart detail={acceptance.empty} />
            : <AreaChart className="reports-acceptance-chart" h={76} textColor="#9691a8"
              data={acceptance.points} dataKey="date" series={[
                { name: 'acceptance', label: 'Acceptance rate', color: 'violet.5' },
                ...(source.autonomyRecorded ? [{ name: 'autonomy', label: 'Autonomous completion rate', color: 'teal.5' }] : []),
              ]} yAxisProps={{ domain: [0, 100], tick: axisTick, width: 28 }}
              xAxisProps={{ tick: axisTick, interval: dateLabels(acceptance.points) }}
              gridAxis="xy" withDots withTooltip aria-label={acceptance.label} />}
        </PanelCard>

        <PanelCard className="reports-panel reports-summary" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconSparkles size={15} />} title="Insights &amp; Narrative"
            actions={<Select className="reports-insight-filter" aria-label="Insights view" data={insightViews}
              rightSection={chevron} rightSectionPointerEvents="none"
              value={insightView} onChange={(value) => setInsightView(value ?? 'executive')} />} />
          <div className="reports-insights">
            {visibleInsights.map((insight) => <div className="reports-insight" key={insight.title}>
              {insight.icon}<div><b>{insight.title}</b><span>{insight.detail}</span></div>
            </div>)}
          </div>
          <div className="reports-key-takeaway"><IconSparkles size={14} /><span><b>Key takeaway</b>
            {source.keyTakeaway}</span></div>
        </PanelCard>

        <ProductSummaryPanel {...source.products} checkoutCount={source.products.checkoutCount} autonomyNote={source.autonomyNote} />
        <WorkspaceSummaryPanel rows={source.workspaces} autonomyNote={source.autonomyNote} />
        <DownloadableReports reports={source.downloads} />
      </div>
    </section>
  );
}
