import { Select, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

const cliProviders = ['codex-cli', 'claude-code'];
const providerSchema = z.object({ id: z.string(), version: z.string().optional(), ready: z.boolean() });
export const workerProvidersSchema = z.array(providerSchema).optional();
const issueOptionsSchema = z.array(z.object({ number: z.number(), title: z.string() }));

export type RunWorker = {
  id: string; name: string; agent_runtime_enabled?: boolean; providers?: z.infer<typeof providerSchema>[];
};

/** Says whether the worker behind a project can execute the selected agent profile's provider. */
export function runReadiness(provider: string | undefined, worker: RunWorker | undefined) {
  if (provider && cliProviders.includes(provider)) {
    const status = worker?.providers?.find((item) => item.id === provider);
    if (status?.ready) {
      return { ready: true, label: `${provider} ready`,
        note: `${worker?.name} reports ${status.version || provider} installed and signed in.` };
    }
    return { ready: false, label: `${provider} not ready`,
      note: `${worker?.name ?? 'This worker'} does not report ${provider} installed and signed in; the run will stay queued.` };
  }
  if (worker?.agent_runtime_enabled === true) {
    return { ready: true, label: 'runtime configured',
      note: `${worker.name} reports an OpenAI-compatible endpoint configured. Queueing saves the run for the worker.` };
  }
  if (worker?.agent_runtime_enabled === false) {
    return { ready: false, label: 'runtime not configured',
      note: `${worker.name} has no OpenAI-compatible endpoint configured; the run will stay queued.` };
  }
  return { ready: false, label: 'runtime status unknown',
    note: 'Worker runtime status is unknown; the run may stay queued until runtime availability is reported.' };
}

async function loadIssueOptions(projectID: string) {
  const response = await fetch(`/api/v1/projects/${projectID}/issues`);
  if (!response.ok) throw new Error(`GitHub issues are unavailable (${response.status})`);
  return issueOptionsSchema.parse(await response.json());
}

/** Lets a run start from an open GitHub issue of the selected project. Choosing none keeps a prompt-only run. */
export function RunIssueSelect({ projectID, value, onChange }: {
  projectID: string; value: number | null; onChange: (issue: number | null) => void;
}) {
  const issues = useQuery({
    queryKey: ['run-issue-options', projectID], queryFn: () => loadIssueOptions(projectID), enabled: projectID !== '',
    retry: false,
  });
  const options = (issues.data ?? []).map((issue) => ({ value: String(issue.number), label: `#${issue.number} ${issue.title}` }));
  return <>
    <Select label="GitHub issue (optional)" data={options} value={value === null ? null : String(value)}
      onChange={(selected) => onChange(selected === null ? null : Number(selected))}
      placeholder={issues.isLoading ? 'Loading open issues…' : options.length ? 'Choose an open issue' : 'No open issues'}
      disabled={!options.length} searchable clearable nothingFoundMessage="No matching issue" />
    {issues.isError && <Text className="agents-issue-note" role="status">
      GitHub issues are unavailable for this project; the run can still start from a task prompt.
    </Text>}
    {value !== null && <Text className="agents-issue-note" role="status">
      The agent receives the issue text and the pull request will close issue #{value}.
    </Text>}
  </>;
}
