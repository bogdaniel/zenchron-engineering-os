import { Button, Code, Group, Stack, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PanelCard } from './PanelCard';

interface StatusGrant { id: string; user: string; created_at: string; expires_at: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error((await response.text()).trim() || `Request failed: ${response.status}`);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function SystemStatusCompanionPanel() {
  const client = useQueryClient();
  const [credential, setCredential] = useState('');
  const [copyError, setCopyError] = useState('');
  const grants = useQuery({ queryKey: ['menu-status-grants'],
    queryFn: () => request<{ grants: StatusGrant[] }>('/api/v1/system/status/credentials') });
  const pair = useMutation({ mutationFn: () => request<{ credential: string }>('/api/v1/system/status/credentials', { method: 'POST' }),
    onSuccess: async (result) => { setCredential(result.credential); await client.invalidateQueries({ queryKey: ['menu-status-grants'] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => request<void>(`/api/v1/system/status/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: async () => { setCredential(''); await client.invalidateQueries({ queryKey: ['menu-status-grants'] }); } });

  return <PanelCard className="system-update-panel" withBorder>
    <h2>Menu Bar Companion</h2>
    <p>Pair this Mac to show local status. Under an access policy, only an administrator can create a grant.</p>
    {grants.data?.grants.map((grant) => <Group key={grant.id} justify="space-between" wrap="nowrap">
      <Text size="sm">{grant.user} · expires {new Date(grant.expires_at).toLocaleDateString()}</Text>
      <Button size="xs" variant="default" onClick={() => revoke.mutate(grant.id)} loading={revoke.isPending}>Revoke</Button>
    </Group>)}
    {credential && <Stack gap="xs" role="status">
      <Text size="sm">Copy this credential, then choose Pair with Dashboard in the menu-bar app. It is shown only once.</Text>
      <Code>{credential}</Code>
      <Button size="xs" variant="default" onClick={() => {
        void navigator.clipboard.writeText(credential).then(() => setCopyError(''), () => setCopyError('Clipboard access failed; select and copy the credential above.'));
      }}>Copy credential</Button>
      {copyError && <Text c="red" role="alert">{copyError}</Text>}
    </Stack>}
    {grants.error instanceof Error && <Text c="red" role="alert">{grants.error.message}</Text>}
    {pair.error instanceof Error && <Text c="red" role="alert">{pair.error.message}</Text>}
    {revoke.error instanceof Error && <Text c="red" role="alert">{revoke.error.message}</Text>}
    <Button variant="default" onClick={() => pair.mutate()} loading={pair.isPending} disabled={pair.isPending}>Pair this Mac</Button>
  </PanelCard>;
}
