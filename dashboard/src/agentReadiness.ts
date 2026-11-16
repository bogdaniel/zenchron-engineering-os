import { runReadiness, type RunWorker } from './agentRunQueue';
import type { Agent, AgentPersona } from './agentsData';

export function profileReadiness(agent: Agent, workers: RunWorker[], persona: AgentPersona | undefined,
  personasLoading: boolean, preview: boolean, workersLoading = false) {
  if (preview) return { label: 'Preview only', note: 'Mock data does not report local CLI readiness.' };
  if (agent.status !== 'active') return { label: 'Profile disabled', note: 'Enable the profile before assigning work.' };
  if (agent.persona_id && personasLoading) return { label: 'Checking persona', note: 'Linked persona readiness is loading.' };
  if (agent.persona_id && persona?.status !== 'active') {
    return { label: 'Persona unavailable', note: 'The linked persona is missing or disabled.' };
  }
  if (workersLoading) return { label: 'Checking worker', note: 'Local worker readiness is loading.' };
  const online = workers.filter((worker) => worker.status === 'online');
  if (!online.length) return { label: 'No online worker', note: 'No online worker can run this profile.' };
  const readyWorker = online.find((worker) => worker.providers?.some((provider) => provider.id === agent.provider && provider.ready));
  return runReadiness(agent.provider, readyWorker ?? online[0]);
}
