import { Badge, Progress, TextInput } from '@mantine/core';
import type { ReactNode } from 'react';
import {
  IconActivity, IconChartBar, IconChevronRight, IconCode,
  IconFileText, IconGitBranch, IconHistory, IconLayersIntersect, IconLink, IconSearch,
  IconTarget, IconUsers,
} from '@tabler/icons-react';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import './workspace-preview.css';

const products = [
  ['Nova Platform', 'Developer platform & tools', 'Active', 'layers'],
  ['Orion Analytics', 'Data & insights for teams', 'Active', 'chart'],
  ['Helix Agents', 'AI engineering agents', 'Active', 'agents'],
  ['Atlas Workspace', 'Team productivity suite', 'Planning', 'workspace'],
  ['Pulse Integrations', 'Platform & third-party sync', 'Active', 'link'],
] as const;

const initiatives = [
  ['Platform v3.0', 'In Progress', '16%', 'green'],
  ['AI Agent SDK', 'In Progress', '47%', 'purple'],
  ['Enterprise Controls', 'Planned', '70%', 'blue'],
  ['Developer Experience', 'Planned', '86%', 'teal'],
] as const;

const objectives = [
  ['Ship Platform v3.0', '78%'],
  ['Launch Agent SDK (Beta)', '62%'],
  ['Improve build & test time by 40%', '34%'],
  ['Expand enterprise readiness', '20%'],
  ['Increase developer adoption', '18%'],
] as const;

const releases = [
  ['Stable (v3.x)', 'Live', 'v3.0.2', '100%', 'green'],
  ['Beta (v3.1)', 'In Progress', 'v3.1.0-rc.2', '72%', 'blue'],
  ['Next (v3.2)', 'Planned', 'v3.2.0', '0%', 'purple'],
] as const;

const decisions = [
  ['Adopt layered agent SDK architecture', 'Approved', '2h ago'],
  ['Move v3.0 GA to Jan 27', 'Approved', '6h ago'],
  ['Use feature flags for enterprise rollout', 'Approved', '1d ago'],
  ['Defer custom permissions to v3.2', 'Pending', '1d ago'],
] as const;

function Card({ title, description, icon, action, className, children }: {
  title: string; description?: string; icon: ReactNode; action?: ReactNode; className?: string; children: ReactNode;
}) {
  return <PanelCard className={`workspace-mock-card${className ? ` ${className}` : ''}`} withBorder>
    <PanelHeading title={title} description={description} icon={<span className="workspace-mock-card-icon">{icon}</span>}
      actions={action && <span className="workspace-mock-card-action">{action}{typeof action === 'string' ? ' →' : null}</span>} />
    {children}
  </PanelCard>;
}

export function WorkspaceDesignPreview() {
  return <section className="workspace-mock" aria-label="Product Workspace design preview" data-preview="mock">
    <aside className="workspace-mock-directory" aria-label="Product workspaces">
      <PanelHeading title="Product Workspace" description="Organize engineering work by product, roadmap, and delivery." />
      <button className="workspace-mock-new" disabled>＋ New Workspace</button>
      <TextInput aria-label="Search products" placeholder="Search products…" leftSection={<IconSearch size={14} />} disabled />
      <div className="workspace-mock-products">
        {products.map(([name, description, state, icon], index) => <button key={name} type="button" disabled
          className={`workspace-mock-product${index === 0 ? ' selected' : ''}`}>
          <span className={`workspace-mock-product-icon ${icon}`}>{icon === 'chart' ? <IconChartBar size={17} />
            : icon === 'link' ? <IconLink size={17} /> : <IconLayersIntersect size={17} />}</span>
          <span className="workspace-mock-product-copy"><b>{name}</b><small>{description}</small></span>
          <Badge className={state === 'Active' ? 'workspace-mock-active' : 'workspace-mock-planning'} variant="light">{state}</Badge>
          <IconChevronRight className="workspace-mock-chevron" size={13} />
        </button>)}
        <button className="workspace-mock-all" disabled><span>▦</span> All Products (5) <IconChevronRight size={13} /></button>
      </div>
    </aside>

    <div className="workspace-mock-detail">
      <header className="workspace-mock-heading">
        <span className="workspace-mock-product-icon large"><IconLayersIntersect size={21} /></span>
        <div><h1>Nova Platform</h1><p>Developer platform, APIs, and core services for building on Zenchron.</p>
          <span className="workspace-mock-meta"><b>● Active</b><i /> Product <i /> Owner: Platform Eng <i /> Updated 2m ago</span></div>
        <button disabled>♧ Share</button><button disabled>•••</button><button className="workspace-mock-add" disabled>＋ Add Product</button>
      </header>

      <div className="workspace-mock-metrics">
        <MetricCard className="workspace-mock-metric health" label="Product Health" value="99.4%" icon={<IconActivity size={14} />}
          detail={<span className="workspace-mock-health">✓ Healthy <svg viewBox="0 0 64 22" aria-hidden="true"><path d="M1 19 12 17 20 18 29 9 39 13 47 6 54 9 63 1" /></svg></span>} />
        <MetricCard className="workspace-mock-metric" label="Active Initiatives" value="7" icon={<IconLayersIntersect size={14} />}
          detail={<span className="workspace-mock-growth">↑ +2</span>} />
        <MetricCard className="workspace-mock-metric delivery" label="Delivery Metrics" value="68%" icon={<IconChartBar size={14} />}
          detail={<span>On-time delivery <b className="workspace-mock-growth">↑ +6 pts</b></span>} />
        <MetricCard className="workspace-mock-metric" label="Recent Decisions" value="5" icon={<IconHistory size={14} />}
          detail="Last 7 days" />
      </div>

      <nav className="workspace-mock-tabs" aria-label="Product sections">
        {['Overview', 'Objectives', 'Repos', 'Files', 'Decisions', 'Templates'].map((tab, index) => <button key={tab} disabled className={index === 0 ? 'active' : ''}>{tab}</button>)}
      </nav>

      <div className="workspace-mock-grid">
        <Card className="roadmap" title="Product Roadmap" description="Strategic delivery plan and key milestones" icon={<IconActivity size={15} />}
          action={<span className="workspace-mock-roadmap-tabs"><b>Roadmap</b><span>◷ Timeline</span><span>Quarterly⌄</span></span>}>
          <div className="workspace-mock-roadmap"><div className="workspace-mock-quarter-labels"><span />{["Q1 ’25", "Q2 ’25", "Today", "Q3 ’25", "Q4 ’25"].map((q) => <span key={q}>{q}</span>)}</div>
            {initiatives.map(([name, status, width, tone]) => <div className="workspace-mock-roadmap-row" key={name}>
              <span className={`workspace-mock-dot ${tone}`} /> <b>{name}</b><div className="workspace-mock-track"><span className={tone} style={{ width }} />{status === 'In Progress' && <em>{status}</em>}</div>
            </div>)}
          </div>
        </Card>
        <Card className="objectives" title="Open Objectives (5)" icon={<IconTarget size={15} />} action="View All">
          <div className="workspace-mock-objectives">{objectives.map(([title, progress], index) => <div key={title}>
            <span className={`workspace-mock-objective-status${index < 2 ? ' done' : ''}`}>{index < 2 ? '✓' : '○'}</span><b>{title}</b>
            <Progress value={Number(progress.slice(0, -1))} size="xs" color="teal.5" /><small>{progress}</small>
          </div>)}</div>
        </Card>

        <Card className="repositories" title="Repositories (6)" icon={<IconCode size={15} />} action="View All">
          <div className="workspace-mock-list">{['zenchron/nova-platform', 'zenchron/agent-sdk', 'zenchron/platform-services', 'zenchron/devtools'].map((repo) => <div key={repo}><IconGitBranch className="workspace-mock-git-icon" size={13} aria-hidden="true" /><b>{repo}</b><span>◌ Main</span></div>)}<small>+ 2 more repositories</small></div>
        </Card>
        <Card className="linked-workflows" title="Linked Workflows (4)" icon={<IconActivity size={15} />} action="View All">
          <div className="workspace-mock-list status-list">{[['PR Review & CI', 'Running'], ['Build & Test', 'Success'], ['Release (Staging)', 'Success'], ['Release (Prod)', 'Scheduled']].map(([name, state]) => <div key={name}><span className="workspace-mock-run">▶</span><b>{name}</b><Badge className={`workspace-mock-state ${state.toLowerCase().replaceAll(' ', '-')}`} variant="light">{state}</Badge></div>)}</div>
        </Card>
        <Card className="files" title="Design / Docs / Files" icon={<IconFileText size={15} />} action="View All">
          <div className="workspace-mock-list files">{[['Designs (Figma)', '24'], ['Documentation', '118'], ['Product Specs', '34'], ['Files & Assets', '269']].map(([name, count], i) => <div key={name}><span>{['●', '▤', '▣', '▱'][i]}</span><b>{name}</b><em>{count}</em></div>)}</div>
        </Card>
        <Card className="people" title="Stakeholders (8)" icon={<IconUsers size={15} />} action="Manage">
          <div className="workspace-mock-list people">{[['Alex Chen', 'Product Owner'], ['Priya Shah', 'Engineering Manager'], ['Marcus Lee', 'Design Lead'], ['Elena Rossi', 'Product Manager']].map(([name, role]) => <div key={name}><span>{name.slice(0, 1)}</span><b>{name}</b><small>{role}</small></div>)}<small>+ 4 more stakeholders</small></div>
        </Card>

        <Card className="release" title="Release Streams" description="Coordinated release trains and environments" icon={<IconCode size={15} />} action="View All">
          <div className="workspace-mock-list release-list">{releases.map(([name, state, version, progress, tone]) => <div key={name}><span className={`workspace-mock-release-icon ${tone}`}>◇</span><b>{name}</b><Badge className={`workspace-mock-state ${state.toLowerCase().replaceAll(' ', '-')}`} variant="light">{state}</Badge><small>{version}</small><Progress value={Number(progress.slice(0, -1))} size="xs" color={tone === 'green' ? 'teal.5' : tone === 'blue' ? 'blue.5' : 'violet.5'} /></div>)}</div>
        </Card>
        <Card className="decisions" title="Recent Decisions" icon={<IconHistory size={15} />} action="View All">
          <div className="workspace-mock-list decision-list">{decisions.map(([name, state, time]) => <div key={name}><IconFileText size={13} /><b>{name}</b><Badge className={`workspace-mock-state ${state.toLowerCase()}`} variant="light">{state}</Badge><small>{time}</small></div>)}</div>
        </Card>
        <Card className="analytics" title="Delivery Metrics" icon={<IconChartBar size={15} />} action="Last 8 weeks">
          <div className="workspace-mock-analytics"><div><span>Cycle Time</span><b>4.2 days <small>↓ −28%</small></b></div><div><span>PR Merge Time</span><b>11.6 hrs <small>↓ −31%</small></b></div><div><span>Change Fail Rate</span><b>1.3% <small>↓ −0.9 pts</small></b></div>
            <svg viewBox="0 0 150 70" preserveAspectRatio="none" aria-label="Delivery trend"><path d="M1 61 17 47 34 49 52 39 68 45 85 34 102 30 119 20 135 13 149 2" /></svg></div>
        </Card>
      </div>
    </div>
  </section>;
}
