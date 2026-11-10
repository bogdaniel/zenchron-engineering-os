import { useState } from 'react';

const designRunSteps = [
  ['Trigger', 0, 7], ['Planner', 8, 15], ['Agent Router', 22, 16], ['Code Reviewer', 36, 34],
  ['Test Generator', 36, 34], ['Coverage Analyzer', 36, 34], ['Human Approval', 71, 15],
  ['Merge Gate', 87, 9], ['Publish Report', 96, 4],
] as const;

export function WorkflowDesignRouterSettings({ section }: { section: 'Properties' | 'Advanced' }) {
  const [newRuleCount, setNewRuleCount] = useState(0);
  const [retriesEnabled, setRetriesEnabled] = useState(true);
  const [conditionsEnabled, setConditionsEnabled] = useState(true);
  return <>
    {section === 'Properties' && <section className="workflow-preview-config" aria-label="Routing Parameters">
      <header><b>Routing Parameters</b><span>⌄</span></header>
      <label>Routing Strategy<div className="workflow-preview-select">Rule-based (with LLM fallback)<span>⌄</span></div></label>
      <div className="workflow-preview-rules">
        <div><code>changes.contains(&quot;*.py,*.js&quot;)</code><span>→</span><b>Code Reviewer</b></div>
        <div><code>changes.affects(&quot;/tests/&quot;)</code><span>→</span><b>Test Generator</b></div>
        <div><code>always</code><span>→</span><b>Coverage Analyzer</b></div>
        {Array.from({ length: newRuleCount }, (_, index) => <div key={index}>
          <input aria-label={`New routing condition ${index + 1}`} placeholder="Enter a condition" />
          <span>→</span><b>Code Reviewer</b></div>)}
      </div>
      <button className="workflow-preview-add-rule" type="button" onClick={() => setNewRuleCount((count) => count + 1)}>
        ＋ Add Rule</button>
    </section>}
    {section === 'Advanced' && <>
    <section className="workflow-preview-config" aria-label="Budgets and limits">
      <header><b>Budgets &amp; Limits</b><span>⌄</span></header>
      <div className="workflow-preview-budget">
        <label>Max Cost (USD)<span>$ 0.020</span></label><label>Max Duration<span>60s</span></label>
        <label>Max Tokens<span>32,000</span></label>
      </div>
    </section>
    <section className="workflow-preview-config" aria-label="Retry Rules">
      <header><b>Retry Rules</b><button className="workflow-preview-toggle" type="button" role="switch"
        aria-label="Retry Rules" aria-checked={retriesEnabled} onClick={() => setRetriesEnabled((value) => !value)} /></header>
      <div className="workflow-preview-retry">
        <label>Max Retries<span>{retriesEnabled ? '2' : 'Off'}</span></label><label>Backoff<span>Exponential</span></label>
        <label>Initial Delay<span>5s</span></label><label>Max Delay<span>30s</span></label>
      </div>
    </section>
    <section className="workflow-preview-config" aria-label="Execution Conditions">
      <header><b>Execution Conditions</b><button className="workflow-preview-toggle" type="button" role="switch"
        aria-label="Execution Conditions" aria-checked={conditionsEnabled}
        onClick={() => setConditionsEnabled((value) => !value)} /></header>
      <label>Run If (expression)<code className="workflow-preview-expression">
        {conditionsEnabled ? 'if (pr.changed_files_count > 0 && pr.is_draft == false)' : 'Execution conditions disabled'}
      </code></label>
      {conditionsEnabled && <div className="workflow-preview-outcomes">
        <label>On Failure<span>Retry (then fail)　⌄</span></label>
        <label>On Success<span>Continue　⌄</span></label>
      </div>}
    </section></>}
  </>;
}

export type WorkflowDesignRunView = 'Execution Graph' | 'Logs' | 'Outputs' | 'Artifacts';

export function WorkflowDesignRunPreview({ view }: { view: WorkflowDesignRunView }) {
  if (view === 'Logs') return <div className="workflow-simulated-output" role="region" aria-label="Illustrative run logs">
    <b>Run Logs · PR #4827</b>
    <code>09:41:02 Trigger received: pull_request</code>
    <code>09:41:10 Planner created 3 tasks</code>
    <code>09:42:18 Tests passed · coverage 84%</code>
  </div>;
  if (view === 'Outputs') return <div className="workflow-simulated-output" role="region" aria-label="Illustrative run outputs">
    <b>Run Outputs</b><code>review.status　approved</code><code>tests.passed　true</code>
    <code>coverage.percent　84</code>
  </div>;
  if (view === 'Artifacts') return <div className="workflow-simulated-output" role="region" aria-label="Illustrative run artifacts">
    <b>Verified Artifacts (7)</b><code>test-results.xml</code><code>coverage-summary.json</code>
    <code>review-report.md</code>
  </div>;
  return <div className="workflow-preview-content workflow-simulated-run">
    <section className="workflow-simulated-timeline" aria-label="Simulated run timeline">
      <div className="workflow-simulated-heading"><b>Simulated run (PR #4827)</b><span>✓ All steps valid</span>
        <small>Est. duration: 2m 14s　·　Est. cost: $0.038</small></div>
      <div className="workflow-simulated-axis"><span>Step</span><div><span>0s</span><span>15s</span><span>30s</span>
        <span>45s</span><span>1m</span><span>1m 15s</span><span>1m 30s</span><span>1m 45s</span><span>2m 14s</span></div></div>
      {designRunSteps.map(([label, start, span], index) => <div className={`workflow-simulated-row ${
        index < 2 ? 'complete' : index === 2 ? 'active' : index < 6 ? 'parallel' : index === 6 ? 'manual' : 'pending'
      }`} key={label}>
        <span>{index === 6 ? '◷' : index < 2 ? '✓' : '○'}　{label}</span>
        <div><i style={{ left: `${start}%`, width: `${span}%` }} /></div>
      </div>)}
    </section>
    <aside className="workflow-simulated-summary">
      <b>Run Summary (est.)</b><label>Total steps<span>7</span></label>
      <label>Parallel steps<span>3</span></label><label>Est. duration<span>2m 14s</span></label>
      <label>Est. cost<span>$0.038</span></label>
      <strong>Success conditions</strong><span>✓ Tests pass</span><span>✓ Coverage ≥ 80%</span>
      <span>✓ Approval = Approved</span>
    </aside>
  </div>;
}
