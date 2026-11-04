import { Badge } from '@mantine/core';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';

const executableTools = [
  { id: 'code.search', label: 'Code search' },
  { id: 'docs.search', label: 'Documentation search' },
  { id: 'git.diff', label: 'Read Git diffs' },
  { id: 'git.read', label: 'Read repository files' },
  { id: 'code.write', label: 'Write files' },
];

export function AgentExecutionOverview({ tools }: { tools: string[] }) {
  return <div className="agents-overview-controls">
    <PanelCard className="agents-overview-access" withBorder>
      <PanelHeading title="Tool permissions" />
      <div className="agents-permission-list">
        {executableTools.map(({ id, label }) => {
          const allowed = tools.includes(id);
          return <div className="agents-permission-row" key={id}>
            <span>{label}</span>
            <Badge className={allowed ? 'agents-permission-enabled' : 'agents-permission-disabled'} variant="light">
              {allowed ? 'Allowed' : 'Not granted'}
            </Badge>
          </div>;
        })}
      </div>
    </PanelCard>
    <PanelCard className="agents-overview-safeguards" withBorder>
      <PanelHeading title="Execution safeguards" />
      <div className="agents-safeguard-list">
        <div><span>Run workspace</span><b>Isolated Git worktree</b></div>
        <div><span>File writes</span><b>{tools.includes('code.write') ? 'Allowed by profile' : 'Not granted'}</b></div>
        <div><span>Test execution</span><b>Unavailable</b></div>
      </div>
    </PanelCard>
  </div>;
}
