import { useState } from 'react';
import {
  IconArrowUpRight, IconCheck, IconChevronRight, IconCode, IconFlame,
  IconPlayerPlay, IconPlus, IconRobot, IconShieldCheck,
} from '@tabler/icons-react';
import { Badge } from '@mantine/core';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import './agents-mobile-preview.css';

type Section = 'agents' | 'reviews' | 'evidence';

export function AgentsMobilePreview({ onRunAgent, onOpenRunHistory, onOpenReviews }: {
  onRunAgent: () => void;
  onOpenRunHistory: () => void;
  onOpenReviews: () => void;
}) {
  const [section, setSection] = useState<Section>('agents');

  return <section className="agents-mobile-preview" aria-label="Agents and reviews mobile dashboard">
    <header className="agents-mobile-heading">
      <div><h1>Agents &amp; Reviews</h1><p>Agent runs, code reviews, and evidence health.</p></div>
      <Badge className="agents-mobile-preview-label">ILLUSTRATIVE DATA</Badge>
    </header>
    <div className="agents-mobile-tabs" role="tablist" aria-label="Agents dashboard sections">
      {([['agents', 'Agents'], ['reviews', 'Reviews'], ['evidence', 'Evidence']] as const).map(([value, label]) =>
        <button key={value} type="button" role="tab" aria-selected={section === value}
          onClick={() => setSection(value)}>{label}</button>)}
    </div>
    <div className="agents-mobile-metrics" aria-label="Illustrative agent metrics">
      <article><span><IconRobot size={15} /> Agent Runs</span><strong>18 <small>↑ +4</small></strong></article>
      <article><span><IconCode size={15} /> PR Reviews</span><strong>42 <small>↑ +27%</small></strong></article>
      <article className="healthy"><span><IconShieldCheck size={15} /> Evidence Health</span><strong>99.4% <IconCheck size={16} /></strong></article>
    </div>
    {section === 'agents' && <PanelCard className="agents-mobile-card" withBorder>
      <PanelHeading title="Recent Agent Runs" actions={<button type="button" onClick={onOpenRunHistory}>All Runs <IconChevronRight size={13} /></button>} />
      <div className="agents-mobile-run-list">
        {[
          ['Code Reviewer', 'PR #4827 · Review and comment', '2m ago'],
          ['Test Generator', 'Generate unit and integration tests', '4m ago'],
          ['Coverage Analyzer', 'Analyze coverage and gaps', '7m ago'],
        ].map(([name, detail, time]) => <div className="agents-mobile-run" key={name}>
          <IconRobot size={17} /><div><b>{name}</b><small>{detail}</small></div>
          <span className="agents-mobile-run-meta"><Badge>Success</Badge><time>{time}</time></span>
        </div>)}
      </div>
    </PanelCard>}
    {(section === 'agents' || section === 'reviews') && <PanelCard className="agents-mobile-card" withBorder>
      <PanelHeading title="Pull Request Reviews" actions={<button type="button" onClick={onOpenReviews}>View All <IconChevronRight size={13} /></button>} />
      <button className="agents-mobile-review" type="button" onClick={onOpenReviews}>
        <span className="review-accent" /><span><b>PR #4827 <Badge>✓ Approved</Badge></b>
          <small>Add usage analytics (v1.3)</small></span><strong>+12 <em>−3</em></strong><IconChevronRight size={15} />
      </button>
    </PanelCard>}
    {(section === 'agents' || section === 'evidence') && <PanelCard className="agents-mobile-card" withBorder>
      <PanelHeading title="Evidence Health" actions={<span className="agents-mobile-healthy">Healthy</span>} />
      <div className="agents-mobile-evidence"><IconCheck size={18} /><span><b>Trusted-main</b>
        <small>Evidence · Test results · Reviews · Traces</small></span><Badge>Healthy</Badge></div>
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
