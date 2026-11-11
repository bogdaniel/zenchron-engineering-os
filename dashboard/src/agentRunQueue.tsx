import { useState } from 'react';
import { Button, Select, Text, Textarea, TextInput } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

const cliProviders = ['codex-cli', 'claude-code'];
const providerSchema = z.object({ id: z.string(), version: z.string().optional(), ready: z.boolean() });
export const workerProvidersSchema = z.array(providerSchema).optional();
const issueOptionSchema = z.object({ number: z.number(), title: z.string() });
const issueOptionsSchema = z.array(issueOptionSchema);

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
  const queryClient = useQueryClient();
  const [drafting, setDrafting] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const createIssue = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/v1/projects/${projectID}/issues`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), body: body.trim() }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `Could not create the issue (${response.status})`);
      return issueOptionSchema.parse(await response.json());
    },
    onSuccess: (issue) => {
      // GitHub's issue list can lag behind creation, so the new issue is added to the cached list directly.
      queryClient.setQueryData<z.infer<typeof issueOptionsSchema>>(['run-issue-options', projectID],
        (current) => [issue, ...(current ?? []).filter((item) => item.number !== issue.number)]);
      onChange(issue.number);
      setTitle('');
      setBody('');
      setDrafting(false);
    },
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
    {projectID !== '' && !drafting && <Button variant="subtle" size="compact-xs" type="button" onClick={() => setDrafting(true)}>
      Create a new issue
    </Button>}
    {drafting && <fieldset className="agents-issue-draft">
      <legend>New GitHub issue</legend>
      <TextInput label="Issue title" maxLength={256} value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
      <Textarea label="Issue description" minRows={3} maxLength={20_000} value={body}
        onChange={(event) => setBody(event.currentTarget.value)}
        description="State the problem, the expected behavior, and acceptance criteria." />
      {createIssue.isError && <Text className="agents-error" role="alert">{createIssue.error.message}</Text>}
      <div className="agents-modal-actions">
        <Button variant="subtle" type="button" onClick={() => setDrafting(false)}>Discard</Button>
        <Button variant="default" type="button" disabled={!title.trim()} loading={createIssue.isPending}
          onClick={() => createIssue.mutate()}>Create issue</Button>
      </div>
    </fieldset>}
  </>;
}
