import { useMemo, useState } from 'react';
import { useForm } from '@mantine/form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { Badge, Button, Modal, Text, TextInput } from '@mantine/core';
import { IconCode, IconCpu, IconFolders, IconGitBranch, IconSearch } from '@tabler/icons-react';
import { z } from 'zod';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { PageHeading } from './PageHeading';
import './projects.css';

ModuleRegistry.registerModules([AllCommunityModule]);

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  branch: z.string(),
  git_remote: z.string().default(''),
  worker_id: z.string(),
  worker_name: z.string(),
  last_seen: z.string(),
  worker_status: z.enum(['online', 'offline']),
});
export const projectsSchema = z.array(projectSchema);
export type Project = z.infer<typeof projectSchema>;
const worktreeSchema = z.object({
  id: z.string(), project_id: z.string(), project_name: z.string(), worker_id: z.string(), worker_name: z.string(),
  branch: z.string(), base_branch: z.string(), status: z.enum(['queued', 'preparing', 'ready', 'failed', 'cancelled']),
  error: z.string().optional(), attempts: z.number(), created_at: z.string(), updated_at: z.string(),
});
const worktreesSchema = z.array(worktreeSchema);
const worktreeInputSchema = z.object({
  project_id: z.string(), branch: z.string().trim().min(1, 'Enter a branch name').max(255), base_branch: z.string(),
});
type WorktreeRequest = z.infer<typeof worktreeSchema>;
type WorktreeInput = z.infer<typeof worktreeInputSchema>;

const projectTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  accentColor: '#a36bff',
  backgroundColor: '#11121b',
  foregroundColor: '#e4dfef',
  borderColor: '#2c293d',
  headerBackgroundColor: '#171622',
  headerTextColor: '#a7a1b8',
  fontSize: 11,
  rowHoverColor: '#201b2c',
  selectedRowBackgroundColor: '#292039',
});

/** `sampleData` is Mock mode: this page has no fixtures, so it says the inventory is Live-only instead of looking empty. */
type Props = { items: Project[]; isLoading: boolean; isError: boolean; sampleData?: boolean };

export function ProjectsPage({ items, isLoading, isError, sampleData = false }: Props) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [prepareError, setPrepareError] = useState('');
  const prepareForm = useForm<WorktreeInput>({
    initialValues: { project_id: '', branch: '', base_branch: '' },
    validate: (values) => {
      const result = worktreeInputSchema.safeParse(values);
      return result.success
        ? {}
        : Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
    },
  });
  const worktrees = useQuery({
    queryKey: ['worktrees'],
    queryFn: async () => {
      const response = await fetch('/api/v1/worktrees');
      if (!response.ok) throw new Error(`Could not load worktree requests (${response.status})`);
      return worktreesSchema.parse(await response.json());
    },
    refetchInterval: 1_500,
  });
  const prepareMutation = useMutation({
    mutationFn: async (input: WorktreeInput) => {
      const response = await fetch('/api/v1/worktrees', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await response.text());
      return worktreeSchema.parse(await response.json());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['worktrees'] });
      setPrepareOpen(false);
      setPrepareError('');
    },
    onError: (error) => setPrepareError(error.message),
  });
  const selected = items.find((project) => project.id === selectedID) ?? items[0];
  const online = items.filter((project) => project.worker_status === 'online').length;
  const offline = items.length - online;
  const workers = new Set(items.map((project) => project.worker_id)).size;
  const selectedWorktrees = worktrees.data?.filter((request) => request.project_id === selected?.id) ?? [];
  const filteredItems = items.filter((project) =>
    `${project.name} ${project.worker_name}`.toLowerCase().includes(search.toLowerCase()),
  );
  const columns = useMemo<ColDef<Project>[]>(() => [
    {
      field: 'name', headerName: 'Repository', flex: 1.5, minWidth: 180,
      cellRenderer: ({ data }: ICellRendererParams<Project>) => data && (
        <span className="project-grid-name"><IconCode size={15} />{data.name}</span>
      ),
    },
    { field: 'branch', headerName: 'Branch', flex: 1, minWidth: 130 },
    { field: 'worker_name', headerName: 'Local worker', flex: 1, minWidth: 140 },
    {
      field: 'worker_status', headerName: 'Checkout', flex: 0.7, minWidth: 100,
      cellRenderer: ({ value }: ICellRendererParams<Project, Project['worker_status']>) => (
        <Badge className={`project-status ${value}`} variant="light">{value ?? 'offline'}</Badge>
      ),
    },
    {
      field: 'last_seen', headerName: 'Last discovered', flex: 1, minWidth: 145,
      valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '—',
    },
  ], []);

  return <div className="projects-page">
    <div className="projects-title-row">
      <PageHeading eyebrow="LOCAL REPOSITORIES" title="Projects" description="Git checkouts reported by your connected development workers." />
      <Badge className="projects-live-badge" variant="light"><i /> {sampleData ? 'No sample data' : 'Worker inventory · live'}</Badge>
    </div>

    <section className="projects-metrics" aria-label="Repository inventory">
      <MetricCard className="projects-metric purple" label="Repositories" value={items.length} detail="Discovered checkouts" icon={<IconFolders size={18} />} />
      <MetricCard className="projects-metric green" label="Online checkouts" value={online} detail="Worker recently checked in" icon={<IconCpu size={18} />} />
      <MetricCard className="projects-metric amber" label="Offline checkouts" value={offline} detail="Worker heartbeat is stale" icon={<IconCpu size={18} />} />
      <MetricCard className="projects-metric blue" label="Workers represented" value={workers} detail="Unique local machines" icon={<IconCpu size={18} />} />
    </section>

    <div className="projects-content-grid">
      <PanelCard className="projects-table-panel" withBorder>
        <PanelHeading className="projects-panel-heading" title="Repository inventory"
          description={isLoading ? 'Loading worker inventory…' : `${filteredItems.length} repositories`}
          actions={<TextInput
            aria-label="Search repositories"
            placeholder="Search repos or workers…"
            leftSection={<IconSearch size={15} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />} />
        <div className="projects-grid-wrap">
          {isError ? <div className="projects-grid-message" role="alert">Could not load repository inventory.</div> : (
            <AgGridReact<Project>
              theme={projectTheme}
              rowData={filteredItems}
              columnDefs={columns}
              getRowId={({ data }) => data.id}
              rowHeight={50}
              headerHeight={38}
              pagination
              paginationPageSize={8}
              onRowClicked={({ data }) => { if (data) setSelectedID(data.id); }}
              overlayNoRowsTemplate={
                `<span class="ag-overlay-no-rows-center">${sampleData
                  ? 'Repository inventory has no sample data. Switch to Live to see worker checkouts.' : 'No local Git checkouts discovered.'}</span>`
              }
            />
          )}
        </div>
      </PanelCard>

      <PanelCard className="project-detail-panel" withBorder>
        {selected ? <>
          <div className="project-detail-heading">
            <span className="project-detail-icon"><IconCode size={19} /></span>
            <div><span className="eyebrow">GIT CHECKOUT</span><h3>{selected.name}</h3></div>
          </div>
          <Badge className={`project-status ${selected.worker_status}`} variant="light">{selected.worker_status}</Badge>
          <div className="project-detail-fields">
            <div><small>Current branch</small><b>{selected.branch || 'Unknown'}</b></div>
            <div><small>Git remote</small><code>{selected.git_remote || 'Not configured'}</code></div>
            <div><small>Worker</small><b>{selected.worker_name}</b></div>
            <div><small>Last heartbeat</small><b>{new Date(selected.last_seen).toLocaleString()}</b></div>
            <div><small>Repository identity</small><code>{selected.id}</code></div>
            <div><small>Worker identity</small><code>{selected.worker_id}</code></div>
          </div>
          <p className="project-detail-note">
            Only the sanitized origin host and repository path leave the worker; local paths and remote credentials stay here.
          </p>
          <Button
            className="prepare-worktree-button"
            leftSection={<IconGitBranch size={15} />}
            disabled={selected.worker_status !== 'online' || !selected.branch || selected.branch === 'Unknown' ||
              selected.branch === 'Detached HEAD'}
            onClick={() => {
              setPrepareError('');
              prepareForm.setValues({
                project_id: selected.id,
                branch: `zenchron/${selected.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${Date.now()}`,
                base_branch: selected.branch,
              });
              setPrepareOpen(true);
            }}
          >Prepare isolated branch</Button>
          <div className="project-worktrees">
            <div className="project-worktrees-heading"><b>Prepared workspaces</b>
              <span>{worktrees.isError ? 'Unavailable' : selectedWorktrees.length}</span></div>
            {worktrees.isError ? <p role="alert">Could not load worktree requests.</p> : selectedWorktrees.length ? (
              selectedWorktrees.slice(0, 4).map((request: WorktreeRequest) => (
                <div className="project-worktree-row" key={request.id}>
                  <IconGitBranch size={14} />
                  <span><b>{request.branch}</b><small>Base: {request.base_branch}</small>
                    {request.error && <small>{request.error}</small>}</span>
                  <Badge className={`worktree-status ${request.status}`} variant="light">{request.status}</Badge>
                </div>
              ))
            ) : <p>{worktrees.isLoading ? 'Loading workspaces…'
              : 'No isolated branches prepared for this checkout.'}</p>}
          </div>
        </> : <div className="projects-empty-detail">
          <IconFolders size={23} />
          <h3>{sampleData ? 'Live data only' : isError ? 'Inventory unavailable' : 'No repositories found'}</h3>
          {sampleData ? <p>Worker checkouts are never mocked. Choose Live in the sidebar to see them.</p> : <p>
            Start the local worker with <code>ZENCHRON_PROJECTS_ROOT</code> set to a folder containing Git checkouts.
          </p>}
        </div>}
      </PanelCard>
    </div>
    <Modal opened={prepareOpen} onClose={() => setPrepareOpen(false)} title="Prepare isolated branch" centered>
      <form onSubmit={prepareForm.onSubmit((values) => {
        prepareMutation.mutate(worktreeInputSchema.parse(values));
      })}>
        <TextInput label="Branch name" required {...prepareForm.getInputProps('branch')} />
        <TextInput label="Base branch" readOnly {...prepareForm.getInputProps('base_branch')} />
        <p className="prepare-worktree-note">
          The worker will create a separate Git worktree. Your current checkout and branch will stay unchanged.
        </p>
        {prepareError && <Text className="form-error" role="alert">{prepareError}</Text>}
        <div className="prepare-worktree-actions">
          <Button variant="subtle" type="button" onClick={() => setPrepareOpen(false)}>Cancel</Button>
          <Button className="prepare-worktree-button" type="submit" loading={prepareMutation.isPending}>
            Prepare branch
          </Button>
        </div>
      </form>
    </Modal>
  </div>;
}
