import { useState } from 'react';
import { IconChecks, IconCircleCheck, IconShieldCheck, IconSparkles, IconUserCheck } from '@tabler/icons-react';
import type { ReviewContextData } from './reviewsView';

/** The six context cards under a pull request's diff. Without `data` each card says what is not available. */
export function ReviewContext({ data }: { data?: ReviewContextData }) {
  const [suggestionApplied, setSuggestionApplied] = useState(false);
  return <div className="reviews-context-panels" aria-label="Additional review context">
    <section className="reviews-context-card"><h4><IconSparkles size={13} /> AI Suggestions {data && <small>{data.suggestionCount}</small>}</h4>
      {data ? <ul className="reviews-preview-card-list reviews-preview-suggestions">
        {data.suggestions.map((suggestion, index) => <li key={suggestion.title}><b>{suggestion.title}</b><span>{suggestion.impact}</span>
          {index === 0 && <button type="button"
            title="This only marks the illustrative suggestion in the local preview; repository code is unchanged"
            onClick={() => setSuggestionApplied(true)}>{suggestionApplied ? 'Applied · preview' : 'Apply'}</button>}</li>)}
      </ul> : <span>Suggestions are unavailable for this pull request.</span>}
    </section>
    <section className="reviews-context-card"><h4><IconShieldCheck size={13} /> Evidence Artifacts {data && <small>{data.artifacts.length}</small>}</h4>
      {data ? <ul className="reviews-preview-card-list reviews-preview-artifacts">
        {data.artifacts.map((artifact) => <li key={artifact}><IconShieldCheck size={10} /><span>{artifact}</span><b>Verified</b></li>)}
      </ul> : <span>Artifact data is unavailable.</span>}
    </section>
    <section className="reviews-context-card"><h4><IconChecks size={13} /> Review Checklist {data && <small>{data.checklist.done}</small>}</h4>
      {data ? <ul className="reviews-preview-card-list reviews-preview-checklist">
        {data.checklist.items.map((check) => <li key={check}><IconCircleCheck size={10} /><span>{check}</span></li>)}
      </ul> : <span>Provider check data is unavailable.</span>}
    </section>
    <section className="reviews-context-card reviews-context-secondary">
      <h4><IconUserCheck size={13} /> Approvals {data && <small>{data.approvals.summary}</small>}</h4>
      {data ? data.approvals.lines.map((line) => <span key={line}>{line}</span>) : <span>Review approvals are not synchronized.</span>}
    </section>
    <section className="reviews-context-card reviews-context-secondary">
      <h4><IconChecks size={13} /> Policy Gate Status {data && <small>{data.policyGates.summary}</small>}</h4>
      {data ? data.policyGates.lines.map((line) => <span key={line}>{line}</span>) : <span>Policy gates are not evaluated by the control plane.</span>}
    </section>
    <section className="reviews-context-card reviews-context-secondary">
      <h4><IconShieldCheck size={13} /> Trusted-main Readiness</h4>
      {data ? data.readiness.map((line) => <span key={line}>{line}</span>) : <span>Merge readiness is unavailable.</span>}
    </section>
  </div>;
}
