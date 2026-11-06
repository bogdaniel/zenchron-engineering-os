import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, TextInput } from '@mantine/core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  IconActivity,
  IconBell,
  IconBrandGithub,
  IconChartBar,
  IconChevronDown,
  IconCode,
  IconHome,
  IconHierarchy,
  IconStack2,
  IconLogout,
  IconPuzzle,
  IconRobot,
  IconSearch,
  IconSettings,
  IconTarget,
} from '@tabler/icons-react';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import { objectivesSchema, ObjectivesPage } from './objectives';
import { projectsSchema, ProjectsPage } from './projects';
import { WorkflowsPage } from './workflows';
import { ReviewsPage } from './reviews';
import { AgentsPage, loadAgentRuns } from './agents';
import { SystemPage } from './system';
import { ReportsPage } from './reports';
import { WorkspacePage } from './workspace';
import { OverviewPage } from './OverviewPage';
import { PageHeading } from './PageHeading';
import { PanelCard } from './PanelCard';
import './style.css';
import './overview.css';
import './monaco.css';

const navigation = [
  { label: 'Overview', href: '#overview', icon: IconHome },
  { label: 'Objectives', href: '#objectives', icon: IconTarget },
  { label: 'Workflows', href: '#workflows', icon: IconHierarchy },
  { label: 'Agents', href: '#agents', icon: IconRobot },
  { label: 'Product Workspace', href: '#workspace', icon: IconStack2 },
  { label: 'Reviews', href: '#reviews', icon: IconCode },
  { label: 'Integrations', href: '#integrations', icon: IconPuzzle },
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
  const previewMode = new URLSearchParams(window.location.search).get('preview');
  const loginPreview = previewMode === 'login';
  const localReviewHost = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
  const designPreview = activePage === 'overview' && (previewMode === 'mock' || (localReviewHost && !loginPreview && previewMode !== 'live'));
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
    enabled: auth.data?.authenticated === true && !designPreview,
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
    enabled: auth.data?.authenticated === true && !designPreview,
  });
  const agentRuns = useQuery({ queryKey: ['agent-runs'], queryFn: loadAgentRuns, refetchInterval: 3_000,
    enabled: auth.data?.authenticated === true && !designPreview });
  const objectives = useQuery({
    queryKey: ['objectives'],
    queryFn: async () => {
      const response = await fetch('/api/v1/objectives');
      if (!response.ok) throw new Error(`Objective list failed: ${response.status}`);
      return objectivesSchema.parse(await response.json());
    },
    enabled: auth.data?.authenticated === true && !designPreview,
  });
  const unauthorized = (auth.error as (Error & { status?: number }) | null)?.status === 401;
  const sessionUnavailable = auth.isError && !unauthorized;
  if (auth.isLoading && !designPreview) return <div className="auth-screen"><span className="brand-mark" /><p>Checking your Zenchron session…</p></div>;
  if (!designPreview && ((auth.isError && unauthorized) || loginPreview)) return <div className="auth-screen">
    <div className="auth-card">
      <span className="brand-mark" aria-hidden="true" />
      <div><h1>Zenchron Engineering</h1><p>Sign in to access your engineering control plane.</p></div>
      {auth.data?.local
        ? <><button className="github-login-button" disabled><IconBrandGithub size={19} /> Continue with GitHub</button>
          <p>GitHub sign-in is not configured in this local preview.</p></>
        : <a className="github-login-button" href="/auth/github"><IconBrandGithub size={19} /> Continue with GitHub</a>}
      <a className="auth-preview-link" href="/?preview=mock#overview">Open dashboard preview</a>
    </div>
  </div>;
  return (
    <MantineProvider defaultColorScheme="dark" theme={{ primaryColor: 'violet', fontFamily: 'var(--font-family)' }}>
      <div className={`app-shell ${activePage}-shell${activePage === 'overview' ? ` overview-layout${designPreview ? ' sample-data' : ''}` : ''}`} id="overview">
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
            {designPreview && activePage === 'overview' && <div className="sidebar-bottom-brand">
              <span className="brand-mark" aria-hidden="true" />
              <strong>Zenchron Engineering</strong>
            </div>}
            {!(designPreview && activePage === 'overview') && <strong>Zenchron Engineering</strong>}
            <p>{designPreview && activePage === 'overview' ? 'The AI-native engineering operating system.'
              : 'Autonomous, verifiable, and aligned engineering.'}</p>
            {auth.data?.local && !designPreview && <a className="preview-login-link" href="/?preview=login">Preview sign-in</a>}
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
                title={designPreview && activePage === 'overview' ? <>Good morning, Alex <span aria-hidden="true">👋</span></>
                  : <>Good morning{auth.data?.login ? `, ${auth.data.login}` : ''} <span aria-hidden="true">👋</span></>}
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
              <button className="icon-button notification-button" aria-label="Notifications" disabled><IconBell size={19} />
                {designPreview && <span className="notification-indicator" aria-hidden="true" />}</button>
              {!designPreview && auth.data?.authenticated && auth.data.local === false && <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={async () => {
                await fetch('/api/v1/auth/logout', { method: 'POST' });
                await auth.refetch();
              }}><IconLogout size={17} /></button>}
              <button className="workspace-button" disabled>
                <span className="workspace-glyph">{designPreview ? <IconStack2 size={15} /> : 'Z'}</span>
                {designPreview ? 'Core Product' : 'Workspace'} <IconChevronDown size={15} />
              </button>
              <div className="user-chip">
                {designPreview ? <img className="avatar avatar-image" src="/alex-chen-avatar.jpg" alt="" /> : auth.data?.avatar_url
                  ? <img className="avatar avatar-image" src={auth.data.avatar_url} alt="" />
                  : <span className="avatar">{auth.data?.local ? 'Z' : auth.data?.login?.slice(0, 1).toUpperCase() ?? '?'}</span>}
                <span>{designPreview ? 'Alex Chen' : auth.data?.local ? 'Local workspace' : auth.data?.login ?? 'Session unavailable'}
                  <small>{designPreview ? 'Engineering Lead' : auth.data?.local ? 'Administrator' : auth.data?.login ? 'GitHub account' : 'Preview only'}</small></span>
                {designPreview && <IconChevronDown className="user-profile-chevron" size={15} aria-hidden="true" />}
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
          </PanelCard></section> : activePage === 'overview' ? <OverviewPage sampleData={designPreview}
            projects={projects.data} projectsLoading={projects.isLoading} projectsError={projects.isError}
            objectives={objectives.data} objectivesLoading={objectives.isLoading} objectivesError={objectives.isError}
            agentRuns={agentRuns.data} agentRunsLoading={agentRuns.isLoading} agentRunsError={agentRuns.isError}
            onlineWorkers={onlineWorkers.length} onlineWorkerNames={onlineWorkers.map((worker) => worker.name)}
            controlPlaneOnline={health.isSuccess} /> : activePage === 'agents' ? <AgentsPage projects={projects.data ?? []} workers={workers.data ?? []} /> : activePage === 'reviews' ? <ReviewsPage runs={agentRuns.data ?? []} projects={projects.data ?? []} /> : activePage === 'workflows' ? <WorkflowsPage /> : activePage === 'projects' ? (
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
          ) : null}
        </main>
      </div>
    </MantineProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}><App /></QueryClientProvider>,
);
