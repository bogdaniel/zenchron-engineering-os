import { useState } from 'react';
import {
  IconArrowUpRight, IconCheck, IconChevronRight, IconCode, IconFlame,
  IconPlayerPlay, IconPlus, IconRobot, IconShieldCheck,
} from '@tabler/icons-react';
import { Badge } from '@mantine/core';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import type { AgentsView } from './agentsView';
import './agents-mobile-preview.css';

type Section = 'agents' | 'reviews' | 'evidence';

/** The phone-sized Agents landing view: recent runs, pull-request review, and evidence health at a glance. */
export function AgentsMobileSummary({ dataLabel, summary, onRunAgent, onOpenRunHistory, onOpenReviews }: {
  dataLabel?: string;
  summary: AgentsView['mobile'];
  onRunAgent: () => void;
  onOpenRunHistory: () => void;
  onOpenReviews: () => void;
}) {
  const [section, setSection] = useState<Section>('agents');
  const { metrics, runs, review, evidence } = summary;

  return <section className="agents-mobile-preview" aria-label="Agents and reviews mobile dashboard">
    <header className="agents-mobile-heading">
      <div><h1>Agents &amp; Reviews</h1><p>Agent runs, code reviews, and evidence health.</p></div>
      {dataLabel && <Badge className="agents-mobile-preview-label">{dataLabel}</Badge>}
    </header>
    <div className="agents-mobile-tabs" role="tablist" aria-label="Agents dashboard sections">
      {([['agents', 'Agents'], ['reviews', 'Reviews'], ['evidence', 'Evidence']] as const).map(([value, label]) =>
        <button key={value} type="button" role="tab" aria-selected={section === value}
          onClick={() => setSection(value)}>{label}</button>)}
    </div>
    <div className="agents-mobile-metrics" aria-label="Agent metrics">
      <article><span><IconRobot size={15} /> Agent Runs</span>
        <strong>{metrics.runs.value} {metrics.runs.change && <small>{metrics.runs.change}</small>}</strong></article>
      <article><span><IconCode size={15} /> PR Reviews</span>
        <strong>{metrics.reviews.value} {metrics.reviews.change && <small>{metrics.reviews.change}</small>}</strong></article>
      <article className="healthy"><span><IconShieldCheck size={15} /> Evidence Health</span>
        <strong>{metrics.evidence.value} {evidence && <IconCheck size={16} />}</strong></article>
    </div>
    {section === 'agents' && <PanelCard className="agents-mobile-card" withBorder>
      <PanelHeading title="Recent Agent Runs" actions={<button type="button" onClick={onOpenRunHistory}>All Runs <IconChevronRight size={13} /></button>} />
      <div className="agents-mobile-run-list">
        {runs.length ? runs.map((run) => <div className="agents-mobile-run" key={run.id}>
          <IconRobot size={17} /><div><b>{run.name}</b><small>{run.detail}</small></div>
          <span className="agents-mobile-run-meta"><Badge>{run.status}</Badge><time>{run.time}</time></span>
        </div>) : <p className="agents-mobile-empty">No agent runs recorded.</p>}
      </div>
    </PanelCard>}
    {(section === 'agents' || section === 'reviews') && <PanelCard className="agents-mobile-card" withBorder>
      <PanelHeading title="Pull Request Reviews" actions={<button type="button" onClick={onOpenReviews}>View All <IconChevronRight size={13} /></button>} />
      {review ? <button className="agents-mobile-review" type="button" onClick={onOpenReviews}>
        <span className="review-accent" /><span><b>{review.title} <Badge>{review.badge}</Badge></b>
          <small>{review.detail}</small></span>
        {review.added && <strong>{review.added} <em>{review.removed}</em></strong>}<IconChevronRight size={15} />
      </button> : <p className="agents-mobile-empty">No agent run has opened a pull request.</p>}
    </PanelCard>}
    {(section === 'agents' || section === 'evidence') && <PanelCard className="agents-mobile-card" withBorder>
      <PanelHeading title="Evidence Health" actions={evidence && <span className="agents-mobile-healthy">{evidence.badge}</span>} />
      {evidence ? <div className="agents-mobile-evidence"><IconCheck size={18} /><span><b>{evidence.title}</b>
        <small>{evidence.detail}</small></span><Badge>{evidence.badge}</Badge></div>
        : <p className="agents-mobile-empty">Evidence health is not reported by the control plane. Open a run in Reviews to read its evidence.</p>}
    </PanelCard>}
    <PanelCard className="agents-mobile-card agents-mobile-quick-actions" withBorder>
      <PanelHeading title="Quick Actions" icon={<IconFlame size={16} />} />
      <div><button type="button" className="run" onClick={onRunAgent}><IconPlayerPlay size={17} />
        <span><b>Run Agent</b><small>Execute an agent now</small></span></button>
        <button type="button" className="review" onClick={onOpenReviews}><IconPlus size={17} />
          <span><b>New Review</b><small>Review a pull request</small></span><IconArrowUpRight size={12} /></button></div>
    </PanelCard>
  </section>;
}
