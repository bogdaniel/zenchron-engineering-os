import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LineChart } from '@mantine/charts';
import { Badge, MantineProvider, TextInput } from '@mantine/core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  IconActivity,
  IconBell,
  IconBrandGithub,
  IconChartBar,
  IconChevronDown,
  IconCircleCheck,
  IconCode,
  IconCurrencyDollar,
  IconFolders,
  IconGitBranch,
  IconGitPullRequest,
  IconHistory,
  IconLayoutDashboard,
  IconLayersIntersect,
  IconLogout,
  IconPlugConnected,
  IconRobot,
  IconRoute,
  IconSearch,
  IconShieldCheck,
  IconSettings,
  IconTarget,
} from '@tabler/icons-react';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import { objectivesSchema, ObjectivesPage } from './objectives';
import { projectsSchema, ProjectsPage } from './projects';
import type { Project } from './projects';
import { WorkflowOverview, WorkflowsPage } from './workflows';
import { ReviewsPage } from './reviews';
import { AgentsPage, loadAgentRuns } from './agents';
import { SystemPage } from './system';
import { ReportsPage } from './reports';
import { WorkspacePage } from './workspace';
import { PageHeading } from './PageHeading';
import { useReportPullRequestMetrics } from './reportPullRequests';
import { useReportWorkflowRunMetrics } from './reportWorkflowRuns';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import './style.css';
import './overview.css';
import './monaco.css';

const navigation = [
  { label: 'Overview', href: '#overview', icon: IconLayoutDashboard },
  { label: 'Objectives', href: '#objectives', icon: IconTarget },
  { label: 'Workflows', href: '#workflows', icon: IconRoute },
  { label: 'Agents', href: '#agents', icon: IconRobot },
  { label: 'Product Workspace', href: '#workspace', icon: IconLayersIntersect },
  { label: 'Reviews', href: '#reviews', icon: IconGitPullRequest },
  { label: 'Integrations', href: '#integrations', icon: IconPlugConnected },
  { label: 'Reports', href: '#reports', icon: IconChartBar },
  { label: 'Settings', href: '#settings', icon: IconSettings },
];
const pageIDs = [
  'overview', 'objectives', 'workflows', 'agents', 'projects', 'workspace', 'reviews', 'integrations', 'reports',
  'settings',
];
function pageFromHash() {
  const page = window.location.hash.slice(1);
  return pageIDs.includes(page) ? page : 'overview';
}

const queryClient = new QueryClient();
const healthResponse = z.object({ status: z.literal('ok') });
const authResponse = z.object({ authenticated: z.boolean(), local: z.boolean(), login: z.string(), avatar_url: z.string().optional() });
const workersResponse = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['online', 'offline']),
    last_seen: z.string(),
    agent_runtime_enabled: z.boolean().optional(),
  }),
);
function App() {
  const [activePage, setActivePage] = useState(pageFromHash);
  useEffect(() => {
    const syncPage = () => setActivePage(pageFromHash());
    window.addEventListener('popstate', syncPage);
    window.addEventListener('hashchange', syncPage);
    return () => {
      window.removeEventListener('popstate', syncPage);
      window.removeEventListener('hashchange', syncPage);
    };
  }, []);
  const auth = useQuery({
    queryKey: ['auth-session'],
    queryFn: async () => {
      const response = await fetch('/api/v1/auth/session');
      if (!response.ok) throw Object.assign(new Error(`Session check failed: ${response.status}`), { status: response.status });
      return authResponse.parse(await response.json());
    },
    retry: false,
  });
  const navigatePage = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!pageIDs.includes(href.slice(1))) return;
    event.preventDefault();
    window.history.pushState({}, '', href);
    setActivePage(href.slice(1));
  };
  const health = useQuery({
    queryKey: ['control-plane-health'],
    queryFn: async () => {
      const response = await fetch('/healthz');
      if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
      return healthResponse.parse(await response.json());
    },
    refetchInterval: 5_000,
  });
  const workers = useQuery({
    queryKey: ['local-workers'],
    queryFn: async () => {
      const response = await fetch('/api/v1/workers');
      if (!response.ok) throw new Error(`Worker list failed: ${response.status}`);
      return workersResponse.parse(await response.json());
    },
    refetchInterval: 5_000,
    enabled: auth.data?.authenticated === true,
  });
  const onlineWorkers = workers.data?.filter((worker) => worker.status === 'online') ?? [];
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const response = await fetch('/api/v1/projects');
      if (!response.ok) throw new Error(`Project list failed: ${response.status}`);
      return projectsSchema.parse(await response.json());
    },
    refetchInterval: 5_000,
    enabled: auth.data?.authenticated === true,
  });
  const agentRuns = useQuery({ queryKey: ['agent-runs'], queryFn: loadAgentRuns, refetchInterval: 3_000, enabled: auth.data?.authenticated === true });
  const reviewableRuns = agentRuns.data?.filter((run) => run.diff_available) ?? [];
  const objectives = useQuery({
    queryKey: ['objectives'],
    queryFn: async () => {
      const response = await fetch('/api/v1/objectives');
      if (!response.ok) throw new Error(`Objective list failed: ${response.status}`);
      return objectivesSchema.parse(await response.json());
    },
    enabled: auth.data?.authenticated === true,
  });
  const openObjectives = objectives.data?.filter((objective) => objective.status !== 'completed') ?? [];
  const unauthorized = (auth.error as (Error & { status?: number }) | null)?.status === 401;
  const sessionUnavailable = auth.isError && !unauthorized;
  const loginPreview = new URLSearchParams(window.location.search).get('preview') === 'login';
  if (auth.isLoading) return <div className="auth-screen"><span className="brand-mark" /><p>Checking your Zenchron session…</p></div>;
  if ((auth.isError && unauthorized) || loginPreview) return <div className="auth-screen">
    <div className="auth-card">
      <span className="brand-mark" aria-hidden="true" />
      <div><h1>Zenchron Engineering</h1><p>Sign in to access your engineering control plane.</p></div>
      {auth.data?.local
        ? <><button className="github-login-button" disabled><IconBrandGithub size={19} /> Continue with GitHub</button>
          <p>GitHub sign-in is not configured in this local preview.</p></>
        : <a className="github-login-button" href="/auth/github"><IconBrandGithub size={19} /> Continue with GitHub</a>}
    </div>
  </div>;
  return (
    <MantineProvider defaultColorScheme="dark" theme={{ primaryColor: 'violet', fontFamily: 'var(--font-family)' }}>
      <div className={`app-shell ${activePage}-shell`} id="overview">
        <aside className="sidebar">
          <a className="brand" href="#overview" aria-label="Zenchron Engineering home">
            <span className="brand-mark" aria-hidden="true" />
            <span>Zenchron<small>Engineering</small></span>
          </a>
          <nav aria-label="Main navigation">
            {navigation.map(({ label, href, icon: Icon }) => (
              <a className={`nav-link${href === `#${activePage}` ? ' active' : ''}`} href={href} key={label} onClick={(event) => navigatePage(event, href)}>
                <Icon size={18} stroke={1.8} />
                <span className="nav-label" data-mobile-label={href === '#overview' ? 'Home' : href === '#settings' ? 'Profile' : undefined}>
                  {label}
                </span>
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <strong>Zenchron Engineering</strong>
            <p>Autonomous, verifiable, and aligned engineering.</p>
            {auth.data?.local && <a className="preview-login-link" href="/?preview=login">Preview sign-in</a>}
          </div>
        </aside>

        <main className="main-content">
          <header className="topbar">
            {activePage === 'reports' ? <div className="greeting reports-greeting">
                <IconChartBar size={22} aria-hidden="true" />
                <PageHeading className="reports-heading-copy" titleClassName="reports-heading-title" titleLevel={1}
                  title="Reports" titleAdornment={<span>Engineering Operations Analytics</span>}
                  description="Executive analytics for delivery, quality, productivity, and agent operations across products and workspaces." />
              </div> : <PageHeading className="greeting" titleLevel={1}
                title={<>Good morning{auth.data?.login ? `, ${auth.data.login}` : ''} <span aria-hidden="true">👋</span></>}
                description={activePage === 'overview' ? <>
                  <span className="greeting-desktop-copy">Your AI-native engineering operating system for objectives, agents, code, and delivery.</span>
                  <span className="greeting-mobile-copy">Your engineering mission at a glance.</span>
                </> : 'Your engineering control center for objectives, agents, code, and delivery.'} />}
            <TextInput
              className="search-box"
              leftSection={<IconSearch size={17} />}
              placeholder="Search Zenchron…"
              disabled
              rightSection={<kbd>⌘ K</kbd>}
              aria-label="Search"
            />
            <div className="top-actions">
              <button className="icon-button" aria-label="Notifications" disabled><IconBell size={19} /></button>
              {auth.data?.authenticated && auth.data.local === false && <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={async () => {
                await fetch('/api/v1/auth/logout', { method: 'POST' });
                await auth.refetch();
              }}><IconLogout size={17} /></button>}
              <button className="workspace-button" disabled>
                <span className="workspace-glyph">Z</span> Workspace <IconChevronDown size={15} />
              </button>
              <div className="user-chip">
                {auth.data?.avatar_url ? <img className="avatar avatar-image" src={auth.data.avatar_url} alt="" /> : <span className="avatar">{auth.data?.local ? 'Z' : auth.data?.login?.slice(0, 1).toUpperCase() ?? '?'}</span>}
                <span>{auth.data?.local ? 'Local workspace' : auth.data?.login ?? 'Session unavailable'}<small>{auth.data?.local ? 'Administrator' : auth.data?.login ? 'GitHub account' : 'Preview only'}</small></span>
              </div>
            </div>
          </header>

          {activePage === 'overview' && <nav className="overview-mobile-tabs" aria-label="Overview shortcuts">
            <a href="#overview" aria-current="page" onClick={(event) => navigatePage(event, '#overview')}>Overview</a>
            <a href="#objectives" onClick={(event) => navigatePage(event, '#objectives')}>My Work</a>
            <a href="#activity">Alerts</a>
          </nav>}

          {sessionUnavailable ? <section className="session-preview-region" aria-labelledby="session-preview-title"><PanelCard className="session-preview-card" withBorder>
            <IconActivity size={24} aria-hidden="true" />
            <h2 id="session-preview-title">Session check unavailable</h2>
            <p>The dashboard shell is available, but page data stays hidden until your session can be verified.</p>
            <button className="github-login-button" onClick={() => void auth.refetch()}>Retry session check</button>
          </PanelCard></section> : activePage === 'agents' ? <AgentsPage projects={projects.data ?? []} workers={workers.data ?? []} /> : activePage === 'reviews' ? <ReviewsPage runs={agentRuns.data ?? []} projects={projects.data ?? []} /> : activePage === 'workflows' ? <WorkflowsPage /> : activePage === 'projects' ? (
            <ProjectsPage items={projects.data ?? []} isLoading={projects.isLoading} isError={projects.isError} />
          ) : activePage === 'workspace' ? (
            <WorkspacePage
              projects={projects.data}
              objectives={objectives.data}
              projectsLoading={projects.isLoading}
              projectsError={projects.isError}
              objectivesLoading={objectives.isLoading}
              objectivesError={objectives.isError}
            />
          ) : activePage === 'objectives' ? <ObjectivesPage /> : ['integrations', 'settings'].includes(activePage) ? (
            <SystemPage
              section={activePage === 'settings' ? 'settings' : 'integrations'}
              apiOnline={health.isSuccess}
              githubLogin={auth.data?.local === false}
              workerCount={workers.data?.length ?? 0}
              onlineWorkerCount={onlineWorkers.length}
              modelRuntimeWorkerCount={onlineWorkers.filter((worker) => worker.agent_runtime_enabled).length}
              modelRuntimeUnknownWorkerCount={onlineWorkers.filter((worker) => worker.agent_runtime_enabled === undefined).length}
              projectCount={projects.data?.length ?? 0}
              gitHubProjectCount={projects.data?.filter((project) => project.git_remote.startsWith('github.com/')).length ?? 0}
            />
          ) : activePage === 'reports' ? (
            <ReportsPage
              apiOnline={health.isSuccess}
              objectives={objectives.data}
              projects={projects.data}
              workers={workers.data}
            />
          ) : <>
          <OverviewMetrics projects={projects.data} projectsLoading={projects.isLoading} projectsError={projects.isError}
            openObjectives={openObjectives.length}
            runningAgents={agentRuns.isLoading ? '…' : agentRuns.isError ? 'Unavailable'
              : agentRuns.data?.filter((run) => run.status === 'running').length ?? 0}
            onlineWorkers={onlineWorkers.length} />

          <div className="content-grid">
            <WorkflowOverview />

            <PanelCard className="panel activity-panel" id="activity" withBorder>
              <PanelHeading className="panel-heading" icon={<span className="section-icon blue-icon"><IconHistory size={18} /></span>}
                title="Recent Activity"
                actions={<a className="text-link" href="#activity">All activity <span>⌄</span></a>} />
              <div className="activity-list">
                <div><IconCircleCheck className={health.isError ? 'activity-violet' : 'activity-green'} size={17} /><span>Control plane {health.isSuccess ? 'is responding' : health.isError ? 'is unavailable' : 'is connecting'}<small>Go health check · live</small></span><time>{health.isSuccess ? 'Now' : 'Live'}</time></div>
                {onlineWorkers.slice(0, 2).map((worker) => (
                  <div key={worker.id}><IconRobot className="activity-blue" size={17} /><span>Worker “{worker.name}” is online<small>Local worker heartbeat</small></span><time>Live</time></div>
                ))}
                {projects.data?.slice(0, 2).map((project) => (
                  <div key={project.id}><IconFolders className="activity-violet" size={17} /><span>Project “{project.name}” discovered<small>On {project.worker_name}</small></span><time>Live</time></div>
                ))}
              </div>
            </PanelCard>

            <PanelCard className="panel objective-panel" id="objectives" withBorder>
              <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconTarget size={18} /></span>}
                title="Objective Status" description="Engineering goals"
                actions={<a className="text-link" href="#objectives" onClick={(event) => navigatePage(event, '#objectives')}>View all →</a>} />
              {openObjectives.length ? (
                <div className="overview-objectives">
                  {openObjectives.slice(0, 3).map((objective) => (
                    <div key={objective.id}><span>{objective.title}<small>{objective.progress}% complete</small></span><Badge className={`objective-status ${objective.status}`} variant="light">{objective.status.replace('_', ' ')}</Badge></div>
                  ))}
                </div>
              ) : (
                <div className="compact-empty"><IconTarget size={20} /><span>{objectives.isError ? 'Objectives unavailable' : 'No objectives created'}</span><small>Create an objective to track delivery.</small></div>
              )}
            </PanelCard>

            <PanelCard className="panel plan-panel" id="approvals" withBorder>
              <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconHistory size={18} /></span>}
                title="Plan Approvals" description="Human review before agent execution" />
              <div className="compact-empty"><IconHistory size={20} />
                <span>Approval data unavailable</span>
                <small>Approval gates are not connected yet.</small>
              </div>
            </PanelCard>

            <PanelCard className="panel agents-panel" id="agents" withBorder>
              <PanelHeading className="panel-heading" icon={<span className="section-icon blue-icon"><IconRobot size={18} /></span>}
                title="Agent Runs" description="Run history · live"
                actions={<a className="text-link" href="#agents" onClick={(event) => navigatePage(event, '#agents')}>View →</a>} />
              {agentRuns.data?.length ? <div className="overview-run-list">
                {agentRuns.data.slice(0, 3).map((run) => <div key={run.id}>
                  <span className={`overview-run-dot ${run.status}`} />
                  <span>{run.agent_name} · {run.project_name}<small>{run.output || run.error || run.prompt}</small></span>
                  <Badge className={`agents-run-badge ${run.status}`} variant="light">{run.status}</Badge>
                </div>)}
              </div> : <div className="compact-empty"><IconRobot size={20} />
                <span>{agentRuns.isError ? 'Run history unavailable' : 'No agent runs yet'}</span>
                <small>{agentRuns.isError ? 'Check the control-plane connection.' : `Connected workers: ${onlineWorkers.length}`}</small>
              </div>}
            </PanelCard>

            <PanelCard className="panel evidence-panel" id="evidence" withBorder>
              <PanelHeading className="panel-heading" icon={<span className="section-icon green-icon"><IconShieldCheck size={18} /></span>}
                title="Evidence Health" description="Artifacts, test results, reviews" />
              <div className="evidence-health-list">
                <div><IconGitBranch size={16} /><span>Trusted branch<small>Branch protection status</small></span><Badge className="muted-tag" variant="light">Unavailable</Badge></div>
                <div><IconShieldCheck size={16} /><span>Evidence source<small>Artifacts · test results · traces</small></span><Badge className="muted-tag" variant="light">Unavailable</Badge></div>
              </div>
            </PanelCard>

            <PanelCard className="panel review-panel" id="reviews" withBorder>
              <PanelHeading className="panel-heading" icon={<span className="section-icon violet-icon"><IconGitPullRequest size={18} /></span>}
                title="Code Review" description="Local branch diffs and feedback"
                actions={<a className="text-link" href="#reviews" onClick={(event) => navigatePage(event, '#reviews')}>Reviews →</a>} />
              {reviewableRuns.length ? <div className="overview-review-list">
                {reviewableRuns.slice(0, 3).map((run) => <div key={run.id}>
                  <IconGitBranch size={17} />
                  <span>{run.project_name} · {run.branch}<small>{run.agent_name} · {run.review_comments.length} comments</small></span>
                  <Badge className={`agents-run-badge ${run.status}`} variant="light">{run.status}</Badge>
                </div>)}
              </div> : <div className="wide-empty">
                <IconGitPullRequest size={22} />
                <b>{agentRuns.isError ? 'Review runs unavailable' : 'No local branch diffs yet'}</b>
                <span>{agentRuns.isError ? 'Check the control-plane connection.' : 'Complete an agent run to review its diff, leave comments, or request changes.'}</span>
              </div>}
            </PanelCard>

            <PanelCard className="panel timeline-panel" id="timeline" withBorder>
              <PanelHeading className="panel-heading" icon={<span className="section-icon blue-icon"><IconHistory size={18} /></span>}
                title="Sprint Timeline" description="Work will be tracked as it progresses" />
              <div className="timeline-empty"><span /><p>Create an objective to start a delivery timeline.</p></div>
            </PanelCard>

            <PanelCard className="panel analytics-panel" id="reports" withBorder>
              <PanelHeading className="panel-heading" icon={<span className="section-icon teal-icon"><IconChartBar size={18} /></span>}
                title="Analytics" description="Pull-request delivery" />
              <OverviewDeliveryChart projects={projects.data} loading={projects.isLoading} error={projects.isError} />
            </PanelCard>
          </div>

          <footer className="page-footer"><span>ZENCHRON ENGINEERING</span><span>Control plane preview</span></footer>
          </>}
        </main>
      </div>
    </MantineProvider>
  );
}

function OverviewDeliveryChart({ projects, loading, error }: {
  projects: Project[] | undefined;
  loading: boolean;
  error: boolean;
}) {
  const pullRequests = useReportPullRequestMetrics(projects, 'all');
  const hasMerges = pullRequests.trend.some((item) => item.merged > 0);
  if (loading || pullRequests.isLoading) return <div className="chart-empty"><span>Loading pull-request history…</span></div>;
  if (error || pullRequests.isError || !pullRequests.complete || !hasMerges) {
    return <div className="chart-empty"><IconChartBar size={23} />
      <span>{pullRequests.githubProjectCount ? 'No merged pull requests yet' : 'No delivery data yet'}</span>
      <small>{pullRequests.githubProjectCount ? 'Merged pull requests will appear here.' : 'Connect a GitHub repository to view delivery.'}</small>
    </div>;
  }
  return <div className="overview-delivery-chart">
    <div className="overview-delivery-summary"><strong>{pullRequests.deliveryVelocity}</strong><span>merged PRs / week</span></div>
    <div role="img" aria-label="Merged pull requests by period">
      <LineChart h={128} data={pullRequests.trend} dataKey="date"
        series={[{ name: 'merged', color: 'violet.5', label: 'Merged PRs' }]}
        curveType="monotone" withDots withTooltip gridAxis="xy" tickLine="xy" />
    </div>
    <div className="overview-delivery-legend"><span />Merged PRs · all history</div>
  </div>;
}

function OverviewMetrics({ projects, projectsLoading, projectsError, openObjectives, runningAgents, onlineWorkers }: {
  projects: Project[] | undefined;
  projectsLoading: boolean;
  projectsError: boolean;
  openObjectives: number;
  runningAgents: number | string;
  onlineWorkers: number;
}) {
  const pullRequests = useReportPullRequestMetrics(projects, 'all');
  const workflows = useReportWorkflowRunMetrics(projects, '30d');
  const openPullRequests = pullRequests.outcomes.find((outcome) => outcome.name === 'Open')?.value ?? 0;
  const pullRequestReady = !projectsLoading && !projectsError && pullRequests.complete;
  const workflowReady = !projectsLoading && !projectsError && workflows.complete;
  const pullRequestValue = projectsLoading || (pullRequests.isLoading && pullRequests.githubProjectCount > 0)
    ? 'Loading…'
    : pullRequestReady ? openPullRequests : 'Unavailable';
  const workflowValue = projectsLoading || (workflows.isLoading && workflows.githubProjectCount > 0)
    ? 'Loading…'
    : workflowReady && workflows.successRate !== undefined ? `${workflows.successRate}%` : 'Unavailable';
  const pullRequestDetail = projectsLoading ? 'Loading repositories'
    : projectsError ? 'Repository inventory unavailable'
      : pullRequests.githubProjectCount === 0 ? 'Connect a GitHub repository'
        : pullRequests.isLoading ? 'Loading GitHub pull-request history'
          : pullRequests.isError ? 'GitHub pull-request history unavailable'
        : !pullRequests.complete ? 'History incomplete; narrow the Reports range' : 'Open GitHub pull requests';
  const workflowDetail = projectsLoading ? 'Loading repositories'
    : projectsError ? 'Repository inventory unavailable'
      : workflows.githubProjectCount === 0 ? 'Connect a GitHub repository'
        : workflows.isLoading ? 'Loading GitHub Actions history'
          : workflows.isError ? 'GitHub Actions history unavailable'
        : !workflows.complete ? 'History incomplete; narrow the Reports range'
          : workflows.completedRunCount ? `${workflows.successfulRuns} of ${workflows.completedRunCount} completed runs passed`
                : workflows.runCount ? 'Completed-run conclusions unavailable'
                  : 'No completed GitHub Actions runs in the last 30 days';
  return <section className="metric-grid" aria-label="Workspace status">
    <MetricCard className="metric-card purple" label="Active Objectives" value={openObjectives}
      detail="Open objectives" icon={<IconTarget size={19} />} />
    <MetricCard className="metric-card blue" label="Running Agents" value={runningAgents}
      detail={`${onlineWorkers} local workers online`} icon={<IconRobot size={19} />} />
    <MetricCard className="metric-card purple pr-queue-metric" label="PR Queue"
      value={pullRequestValue}
      detail={pullRequestReady ? `${openPullRequests} open GitHub pull requests` : pullRequestDetail}
      icon={<IconGitPullRequest size={19} />} />
    <MetricCard className="metric-card green" label="CI Health"
      value={workflowValue}
      detail={workflowDetail}
      icon={<IconActivity size={19} />} />
    <MetricCard className="metric-card cyan" label="Budget Usage" value="Unavailable"
      detail="Budgets are not configured" icon={<IconCurrencyDollar size={19} />} />
  </section>;
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}><App /></QueryClientProvider>,
);
