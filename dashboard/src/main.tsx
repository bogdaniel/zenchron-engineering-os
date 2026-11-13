import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, Menu, SegmentedControl, TextInput } from '@mantine/core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  IconActivity,
  IconBell,
  IconBrandGithub,
  IconChartBar,
  IconChevronDown,
  IconLogout,
  IconSearch,
  IconStack2,
} from '@tabler/icons-react';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import { objectivesSchema, ObjectivesPage } from './objectives';
import { projectsSchema, ProjectsPage } from './projects';
import { WorkflowsPage } from './workflows';
import { ReviewsPage } from './reviews';
import { AgentsPage } from './agents';
import { loadAgentRuns } from './agentsData';
import { SystemPage } from './system';
import { ReportsPage } from './reports';
import { WorkspacePage } from './workspace';
import { OverviewPage } from './OverviewPage';
import { Sidebar } from './Sidebar';
import { PageHeading } from './PageHeading';
import { PanelCard } from './PanelCard';
import { workerProvidersSchema } from './agentRunQueue';
import './style.css';
import './overview.css';
import './monaco.css';

const pageIDs = [
  'overview', 'objectives', 'workflows', 'agents', 'projects', 'workspace', 'reviews', 'integrations', 'reports',
  'settings', 'login',
];
const searchablePages = [
  ['Overview', 'overview'], ['Objectives', 'objectives'], ['Workflows', 'workflows'], ['Agents', 'agents'],
  ['Projects', 'projects'], ['Product Workspace', 'workspace'], ['Reviews', 'reviews'], ['Integrations', 'integrations'],
  ['Reports', 'reports'], ['Settings', 'settings'],
] as const;
// Pages whose Live mode already renders the approved layout. The list goes away once every page is on it.
const unifiedPages = ['agents', 'integrations', 'settings', 'workspace'];
type DashboardMode = 'mock' | 'live';
/** `?mode=mock|live` wins. Without it, local development starts in Mock and any other host starts in Live. */
function modeFromLocation(): DashboardMode {
  const requested = new URLSearchParams(window.location.search).get('mode');
  if (requested === 'mock' || requested === 'live') return requested;
  return window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' ? 'mock' : 'live';
}
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
    providers: workerProvidersSchema,
  }),
);
function App() {
  const [activePage, setActivePage] = useState(pageFromHash);
  const [mode, setMode] = useState(modeFromLocation);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const loginRoute = activePage === 'login';
  useEffect(() => {
    const syncPage = () => { setActivePage(pageFromHash()); setMode(modeFromLocation()); };
    window.addEventListener('popstate', syncPage);
    window.addEventListener('hashchange', syncPage);
    return () => {
      window.removeEventListener('popstate', syncPage);
      window.removeEventListener('hashchange', syncPage);
    };
  }, []);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
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
  const unauthorized = (auth.error as (Error & { status?: number }) | null)?.status === 401;
  // Mock shows the approved fixtures and never calls a mutation endpoint; Live uses the control plane and
  // requires a session. Both render the same pages. Hash-only navigation keeps `?mode=` in the address.
  const previewPage = mode === 'mock' && !loginRoute;
  const chooseMode = (next: DashboardMode) => {
    const url = new URL(window.location.href);
    url.searchParams.set('mode', next);
    window.history.pushState({}, '', url);
    setMode(next);
  };
  // Rendered twice: in the sidebar, and in the header on phones where the sidebar becomes the bottom bar.
  const modeSwitch = (className: string) => <SegmentedControl className={className} size="xs" aria-label="Data mode"
    value={mode} data={[{ value: 'mock', label: 'Mock' }, { value: 'live', label: 'Live' }]}
    onChange={(value) => chooseMode(value === 'live' ? 'live' : 'mock')} />;
  const goToPage = (href: string) => {
    const page = href.slice(1);
    if (!pageIDs.includes(page)) return;
    window.history.pushState({}, '', href);
    setActivePage(page);
    setSearchTerm('');
    setSearchOpen(false);
  };
  const navigatePage = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!pageIDs.includes(href.slice(1))) return;
    event.preventDefault();
    goToPage(href);
  };
  const searchResults = searchablePages.filter(([label]) => label.toLowerCase().includes(searchTerm.trim().toLowerCase()));
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
    enabled: auth.data?.authenticated === true && !previewPage,
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
    enabled: auth.data?.authenticated === true && !previewPage,
  });
  const agentRuns = useQuery({ queryKey: ['agent-runs'], queryFn: loadAgentRuns, refetchInterval: 3_000,
    enabled: auth.data?.authenticated === true && !previewPage });
  const objectives = useQuery({
    queryKey: ['objectives'],
    queryFn: async () => {
      const response = await fetch('/api/v1/objectives');
      if (!response.ok) throw new Error(`Objective list failed: ${response.status}`);
      return objectivesSchema.parse(await response.json());
    },
    enabled: auth.data?.authenticated === true && !previewPage,
  });
  const sessionUnavailable = auth.isError && !unauthorized;
  if (auth.isLoading && !previewPage) return <div className="auth-screen"><span className="brand-mark" /><p>Checking your Zenchron session…</p></div>;
  if (!previewPage && ((auth.isError && unauthorized) || loginRoute)) return <div className="auth-screen">
    <div className="auth-card">
      <span className="brand-mark" aria-hidden="true" />
      <div><h1>Zenchron Engineering</h1><p>Sign in to access your engineering control plane.</p></div>
      {auth.data?.local
        ? <><button className="github-login-button" disabled><IconBrandGithub size={19} /> Continue with GitHub</button>
          <p>GitHub sign-in is not configured in this local preview.</p></>
        : <a className="github-login-button" href="/auth/github"><IconBrandGithub size={19} /> Continue with GitHub</a>}
      <a className="auth-preview-link" href="/#overview">Back to dashboard</a>
    </div>
  </div>;
  return (
    <MantineProvider defaultColorScheme="dark" theme={{ primaryColor: 'violet', fontFamily: 'var(--font-family)' }}>
      <div className={`app-shell ${activePage}-shell${activePage === 'overview' ? ' overview-layout' : ''}${previewPage || unifiedPages.includes(activePage) ? ' sample-data' : ''}`} id="overview">
        <Sidebar activePage={activePage} showSignIn={mode === 'mock'} modeSwitch={modeSwitch('mode-switch')} onNavigate={navigatePage} />

        <main className="main-content">
          <header className="topbar">
            {activePage === 'reports' ? <div className="greeting reports-greeting">
                <IconChartBar size={22} aria-hidden="true" />
                <PageHeading className="reports-heading-copy" titleClassName="reports-heading-title" titleLevel={1}
                  title="Reports" titleAdornment={<span>Engineering Operations Analytics</span>}
                  description="Executive analytics for delivery, quality, productivity, and agent operations across products and workspaces." />
              </div> : <PageHeading className="greeting" titleLevel={1}
                title={previewPage ? <>Good morning, Alex <span aria-hidden="true">👋</span></>
                  : <>Good morning{auth.data?.login ? `, ${auth.data.login}` : ''} <span aria-hidden="true">👋</span></>}
                description={['integrations', 'settings'].includes(activePage) && previewPage
                  ? 'Configure your organization, connect integrations, and control how Zenchron runs.'
                  : activePage === 'workflows' ? 'You’re building and orchestrating intelligent engineering workflows.'
                  : activePage === 'overview' ? <>
                  <span className="greeting-desktop-copy">Your AI-native engineering operating system for objectives, agents, code, and delivery.</span>
                  <span className="greeting-mobile-copy">Your engineering mission at a glance.</span>
                </> : 'Your engineering control center for objectives, agents, code, and delivery.'} />}
            <Menu opened={searchOpen && Boolean(searchTerm.trim())} onChange={setSearchOpen} position="bottom-start" withinPortal>
              <Menu.Target><TextInput ref={searchInput} className="search-box" leftSection={<IconSearch size={17} />}
                placeholder="Search Zenchron…" value={searchTerm} onChange={(event) => {
                  setSearchTerm(event.currentTarget.value);
                  setSearchOpen(true);
                }} onKeyDown={(event) => {
                  if (event.key === 'Enter' && searchResults[0]) goToPage(`#${searchResults[0][1]}`);
                  if (event.key === 'Escape') setSearchOpen(false);
                }} rightSection={<kbd>⌘ K</kbd>} aria-label="Search pages" /></Menu.Target>
              <Menu.Dropdown>{searchResults.length ? searchResults.map(([label, page]) => <Menu.Item key={page}
                onClick={() => goToPage(`#${page}`)}>{label}</Menu.Item>) : <Menu.Item disabled>No pages match your search.</Menu.Item>}</Menu.Dropdown>
            </Menu>
            <div className="top-actions">
              {modeSwitch('mode-switch mode-switch-phone')}
              <Menu position="bottom-end" withinPortal>
                <Menu.Target><button className="icon-button notification-button" aria-label="Notifications" type="button"><IconBell size={19} />
                  {previewPage && <span className="notification-indicator" aria-hidden="true" />}</button></Menu.Target>
                <Menu.Dropdown><Menu.Label>Notifications</Menu.Label><Menu.Item disabled>No new notifications.</Menu.Item></Menu.Dropdown>
              </Menu>
              {!previewPage && auth.data?.authenticated && auth.data.local === false && <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={async () => {
                await fetch('/api/v1/auth/logout', { method: 'POST' });
                await auth.refetch();
              }}><IconLogout size={17} /></button>}
              <Menu position="bottom-end" withinPortal>
                <Menu.Target><button className="workspace-button" type="button" aria-label="Choose workspace">
                  <span className="workspace-glyph">{previewPage ? <IconStack2 size={15} /> : 'Z'}</span>
                  {previewPage ? 'Core Product' : 'Workspace'} <IconChevronDown size={15} />
                </button></Menu.Target>
                <Menu.Dropdown><Menu.Label>{previewPage ? 'Core Product' : 'Workspace'}</Menu.Label>
                  <Menu.Item onClick={() => goToPage('#workspace')}>Open Product Workspace</Menu.Item></Menu.Dropdown>
              </Menu>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target><button className="user-chip" type="button" aria-label="User profile menu">
                  {previewPage ? <img className="avatar avatar-image" src="/alex-chen-avatar.jpg" alt="" /> : auth.data?.avatar_url
                    ? <img className="avatar avatar-image" src={auth.data.avatar_url} alt="" />
                    : <span className="avatar">{auth.data?.local ? 'Z' : auth.data?.login?.slice(0, 1).toUpperCase() ?? '?'}</span>}
                  <span>{previewPage ? 'Alex Chen' : auth.data?.local ? 'Local workspace' : auth.data?.login ?? 'Session unavailable'}
                    <small>{previewPage ? 'Engineering Lead' : auth.data?.local ? 'Administrator' : auth.data?.login ? 'GitHub account' : 'Preview only'}</small></span>
                  {previewPage && <IconChevronDown className="user-profile-chevron" size={15} aria-hidden="true" />}
                </button></Menu.Target>
                <Menu.Dropdown><Menu.Label>{previewPage ? 'Alex Chen' : auth.data?.login ?? 'Account'}</Menu.Label>
                  <Menu.Item onClick={() => goToPage('#settings')}>Open Settings</Menu.Item></Menu.Dropdown>
              </Menu>
            </div>
          </header>

          {activePage === 'overview' && <nav className="overview-mobile-tabs" aria-label="Overview shortcuts">
            <a href="#overview" aria-current="page" onClick={(event) => navigatePage(event, '#overview')}>Overview</a>
            <a href="#objectives" onClick={(event) => navigatePage(event, '#objectives')}>My Work</a>
            <a href="#activity">Alerts</a>
          </nav>}

          {sessionUnavailable && !previewPage ? <section className="session-preview-region" aria-labelledby="session-preview-title"><PanelCard className="session-preview-card" withBorder>
            <IconActivity size={24} aria-hidden="true" />
            <h2 id="session-preview-title">Session check unavailable</h2>
            <p>The dashboard shell is available, but page data stays hidden until your session can be verified.</p>
            <button className="github-login-button" onClick={() => void auth.refetch()}>Retry session check</button>
          </PanelCard></section> : activePage === 'overview' ? <OverviewPage sampleData={previewPage}
            projects={projects.data} projectsLoading={projects.isLoading} projectsError={projects.isError}
            objectives={objectives.data} objectivesLoading={objectives.isLoading} objectivesError={objectives.isError}
            agentRuns={agentRuns.data} agentRunsLoading={agentRuns.isLoading} agentRunsError={agentRuns.isError}
            onlineWorkers={onlineWorkers.length} onlineWorkerNames={onlineWorkers.map((worker) => worker.name)}
          controlPlaneOnline={health.isSuccess} /> : activePage === 'agents' ? <AgentsPage projects={projects.data ?? []} workers={workers.data ?? []} designPreview={previewPage} onNavigate={goToPage} /> : activePage === 'reviews' ? <ReviewsPage runs={agentRuns.data ?? []} projects={projects.data ?? []} designPreview={previewPage} /> : activePage === 'workflows' ? <WorkflowsPage designPreview={previewPage} /> : activePage === 'projects' ? (
            <ProjectsPage items={projects.data ?? []} isLoading={projects.isLoading} isError={projects.isError} />
          ) : activePage === 'workspace' ? (
            <WorkspacePage
              designPreview={previewPage}
              projects={projects.data}
              objectives={objectives.data}
              projectsLoading={projects.isLoading}
              projectsError={projects.isError}
              objectivesLoading={objectives.isLoading}
              objectivesError={objectives.isError}
            />
          ) : activePage === 'objectives' ? <ObjectivesPage sampleData={previewPage} /> : ['integrations', 'settings'].includes(activePage) ? (
            <SystemPage
              section={activePage === 'settings' ? 'settings' : 'integrations'}
              designPreview={previewPage}
              apiOnline={health.isSuccess}
              githubLogin={auth.data?.local === false}
              workerCount={workers.data?.length ?? 0}
              onlineWorkerCount={onlineWorkers.length}
              modelRuntimeWorkerCount={onlineWorkers.filter((worker) => worker.agent_runtime_enabled).length}
              modelRuntimeUnknownWorkerCount={onlineWorkers.filter((worker) => worker.agent_runtime_enabled === undefined).length}
              projectCount={projects.data?.length ?? 0}
              gitHubProjectCount={projects.data?.filter((project) => project.git_remote.startsWith('github.com/')).length ?? 0}
              cliReadyWorkers={Object.fromEntries(['codex-cli', 'claude-code'].map((id) => [id,
                onlineWorkers.filter((worker) => worker.providers?.some((item) => item.id === id && item.ready)).length]))}
            />
          ) : activePage === 'reports' ? (
            <ReportsPage designPreview={previewPage}
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
