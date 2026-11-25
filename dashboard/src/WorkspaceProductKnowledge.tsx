import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Textarea } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { livePageHref } from './livePageHref';
import type { GraphMessage, WorkGraph } from './orchestration';
import type { WorkspaceKnowledgeRow } from './workspaceView';

async function postKnowledge(url: string, body?: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error((await response.text()).trim() || `Request failed (${response.status})`);
}

function KnowledgeCapture({ productID, graph, finding }: {
  productID: string; graph: WorkGraph; finding: GraphMessage;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content.trim() || saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await postKnowledge(`/api/v1/products/${encodeURIComponent(productID)}/knowledge`, {
        content: content.trim(), graph_id: graph.id, message_id: finding.id,
      });
      setContent('');
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['product-environment', productID] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save product knowledge.');
    } finally {
      setSaving(false);
    }
  }

  return <div className="workspace-knowledge-capture">
    <Button size="compact-xs" variant="subtle" onClick={() => setOpen(!open)}>
      {open ? 'Cancel curation' : 'Curate as product knowledge'}
    </Button>
    {open && <form onSubmit={save}>
      <p>Source finding: {finding.title || finding.body || finding.id}. Add a concise reusable note.
        The source stays linked.</p>
      <Textarea aria-label={`Curated knowledge for finding ${finding.id}`} value={content} maxLength={400} minRows={2}
        placeholder="Write a product-specific reference (up to 400 characters)"
        onChange={(event) => setContent(event.currentTarget.value)} />
      {error && <p role="alert" className="work-unit-failure">{error}</p>}
      {saved && <p role="status">Saved with its WorkGraph finding provenance.</p>}
      <Button type="submit" size="xs" loading={saving} disabled={!content.trim()}>Save knowledge</Button>
    </form>}
  </div>;
}

export function WorkspaceFindingKnowledge({ productID, graph }: { productID?: string; graph: WorkGraph }) {
  if (!productID) return null;
  const findings = graph.messages.filter((message) => message.type === 'finding');
  if (!findings.length) return null;
  return <section aria-label={`Curate findings from ${graph.objective_title}`} className="workspace-knowledge-findings">
    <h4>Product knowledge</h4>
    {findings.map((finding) => <KnowledgeCapture key={finding.id} productID={productID} graph={graph}
      finding={finding} />)}
  </section>;
}

export function WorkspaceProductKnowledge({ productID, rows, productRevision, organizationRevision }: {
  productID: string; rows: WorkspaceKnowledgeRow[]; productRevision: number; organizationRevision: number;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [promotingID, setPromotingID] = useState('');

  async function promote(id: string) {
    if (promotingID) return;
    setPromotingID(id);
    setError('');
    try {
      await postKnowledge(`/api/v1/products/${encodeURIComponent(productID)}/knowledge/`
        + `${encodeURIComponent(id)}/promote`);
      await queryClient.invalidateQueries({ queryKey: ['product-environment', productID] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not promote product knowledge.');
    } finally {
      setPromotingID('');
    }
  }

  return <div className="workspace-knowledge-list">
    <p>Product revision {productRevision} · organization revision {organizationRevision}</p>
    {error && <p role="alert" className="work-unit-failure">{error}</p>}
    {rows.length === 0 && <p>No product or promoted organization knowledge is recorded.</p>}
    {rows.map((item) => <article key={`${item.scope}-${item.id}`}>
      <BadgeLabel scope={item.scope} revision={item.revision} />
      <p>{item.content}</p>
      <small>{item.createdBy ? `Recorded by ${item.createdBy}` : 'Actor unrecorded'} ·
        {new Date(item.createdAt).toLocaleString()}</small>
      {item.sourceUnavailable ? <p>Source details are hidden because this viewer cannot read the finding.</p>
        : item.objectiveID && item.graphID && <p><a href={livePageHref('objectives', {
          objective: item.objectiveID, tab: 'plan', graph_id: item.graphID,
        })}>
          Open source objective and WorkGraph</a><small>Graph {item.graphID} · plan {item.planHash || 'unknown'}
            · finding {item.messageID || 'unknown'} · {item.unit || 'unit unknown'} · run {item.runID || 'unknown'}
            · candidate {item.candidate || 'unknown'}</small></p>}
      {item.scope === 'product' && <Button size="compact-xs" variant="light" loading={promotingID === item.id}
        disabled={Boolean(promotingID)} onClick={() => void promote(item.id)}>
        Promote to organization knowledge
      </Button>}
      {item.scope === 'organization' && <small>{item.promotedBy ? `Promoted by ${item.promotedBy}`
        : 'Promoter unrecorded'}</small>}
    </article>)}
  </div>;
}

function BadgeLabel({ scope, revision }: { scope: string; revision: number }) {
  return <strong>{scope === 'product' ? 'Product' : 'Organization'} knowledge · revision {revision}</strong>;
}
