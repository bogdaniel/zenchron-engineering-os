import { useState } from 'react';
import { IconChecks, IconCircleCheck, IconShieldCheck, IconSparkles, IconUserCheck } from '@tabler/icons-react';

const artifacts = [
  'evidence.json · 412 KB', 'review-signals.json · 96 KB', 'test-results.xml · 1.8 MB',
  'coverage-report.html · 724 KB', 'sbom.spdx.json · 1.1 MB', 'attestation.sig · 3 KB', 'policy-trace.json · 88 KB',
];
const checks = [
  'Code follows standards', 'Tests added/updated · coverage ≥85%', 'Evidence artifacts generated',
  'Security scan (SAST/SCA) passed', 'No high-risk dependencies', 'Policy gates configured', 'Trusted-main criteria met',
];

export function ReviewPreviewContext() {
  const [suggestionApplied, setSuggestionApplied] = useState(false);
  return <div className="reviews-context-panels" aria-label="Additional review context">
    <section className="reviews-context-card"><h4><IconSparkles size={13} /> AI Suggestions <small>4</small></h4>
      <ul className="reviews-preview-card-list reviews-preview-suggestions">
        <li><b>Add schema version to evidence artifacts</b><span>Traceability · High</span><button type="button"
          title="This only marks the illustrative suggestion in the local preview; repository code is unchanged"
          onClick={() => setSuggestionApplied(true)}>{suggestionApplied ? 'Applied · preview' : 'Apply'}</button></li>
        <li><b>Handle artifact collection failures</b><span>Reliability · Medium</span></li>
        <li><b>Add tests for evidence builder</b><span>Test coverage · Medium</span></li>
      </ul>
    </section>
    <section className="reviews-context-card"><h4><IconShieldCheck size={13} /> Evidence Artifacts <small>7</small></h4>
      <ul className="reviews-preview-card-list reviews-preview-artifacts">
        {artifacts.map((artifact) => <li key={artifact}><IconShieldCheck size={10} /><span>{artifact}</span><b>Verified</b></li>)}
      </ul>
    </section>
    <section className="reviews-context-card"><h4><IconChecks size={13} /> Review Checklist <small>12/12</small></h4>
      <ul className="reviews-preview-card-list reviews-preview-checklist">
        {checks.map((check) => <li key={check}><IconCircleCheck size={10} /><span>{check}</span></li>)}
      </ul>
    </section>
    <section className="reviews-context-card reviews-context-secondary">
      <h4><IconUserCheck size={13} /> Approvals <small>2/3</small></h4>
      <span>Jordan Kim · Approved · 1h ago</span><span>Riley Torres · Approved · 47m ago</span><span>Casey Morgan · Pending</span>
    </section>
    <section className="reviews-context-card reviews-context-secondary">
      <h4><IconChecks size={13} /> Policy Gate Status <small>5/5</small></h4>
      <span>✓ Security　✓ Quality　✓ Compliance</span><span>✓ Risk　✓ Evidence</span>
    </section>
    <section className="reviews-context-card reviews-context-secondary">
      <h4><IconShieldCheck size={13} /> Trusted-main Readiness</h4><span>Ready to Merge</span><span>All governance checks passed.</span>
    </section>
  </div>;
}
