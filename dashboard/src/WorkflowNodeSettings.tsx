import { useState } from 'react';
import type { WorkflowNodeSettings as NodeSettings } from './workflowsView';

export const nodeSettingsTabs = ['Properties', 'Prompt', 'Variables', 'Advanced'] as const;
export type NodeSettingsTab = typeof nodeSettingsTabs[number];
const settingGroups = ['Routing Parameters', 'Budgets & Limits', 'Retry Rules', 'Execution Conditions'];

/** The inspector's settings below Basic Configuration. Without `settings` every group reads Unavailable. */
export function WorkflowNodeSettings({ settings, tab }: { settings?: NodeSettings; tab: NodeSettingsTab }) {
  const [newRuleCount, setNewRuleCount] = useState(0);
  const [retriesEnabled, setRetriesEnabled] = useState(true);
  const [conditionsEnabled, setConditionsEnabled] = useState(true);
  if (!settings) {
    return <section className="workflow-preview-config" id="router-settings-panel" role="tabpanel" aria-label="Component settings">
      {settingGroups.map((group) => <header key={group}><b>{group}</b><span>Unavailable</span></header>)}
      <p className="workflow-hint">The control plane stores a component&apos;s name and description only.</p>
    </section>;
  }
  return <div id="router-settings-panel" role="tabpanel" aria-label={`${tab} settings`}>
    {tab === 'Prompt' && <section className="workflow-preview-config workflow-router-sample" aria-label="Illustrative router prompt">
      <header><b>Router Prompt</b><span>ILLUSTRATIVE</span></header>
      <p>{settings.prompt}</p>
    </section>}
    {tab === 'Variables' && <section className="workflow-preview-config workflow-router-sample" aria-label="Illustrative router variables">
      <header><b>Available Variables</b><span>ILLUSTRATIVE</span></header>
      {settings.variables.map(([name, description]) => <div className="workflow-router-variable" key={name}>
        <code>{name}</code><span>{description}</span></div>)}
    </section>}
    {/* Hidden, not unmounted, so added rules and switches survive a visit to Prompt or Variables. */}
    <div hidden={tab === 'Prompt' || tab === 'Variables'}>
      {tab !== 'Advanced' && <section className="workflow-preview-config" aria-label="Routing Parameters">
        <header><b>Routing Parameters</b><span>⌄</span></header>
        <label>Routing Strategy<div className="workflow-preview-select">{settings.strategy}<span>⌄</span></div></label>
        <div className="workflow-preview-rules">
          {settings.rules.map(([condition, target]) => <div key={condition}><code>{condition}</code><span>→</span><b>{target}</b></div>)}
          {Array.from({ length: newRuleCount }, (_, index) => <div key={index}>
            <input aria-label={`New routing condition ${index + 1}`} placeholder="Enter a condition" />
            <span>→</span><b>{settings.newRuleTarget}</b></div>)}
        </div>
        <button className="workflow-preview-add-rule" type="button" onClick={() => setNewRuleCount((count) => count + 1)}>
          ＋ Add Rule</button>
      </section>}
      <section className="workflow-preview-config" aria-label="Budgets and limits">
        <header><b>Budgets &amp; Limits</b><span>⌄</span></header>
        <div className="workflow-preview-budget">
          {settings.budget.map(([label, value]) => <label key={label}>{label}<span>{value}</span></label>)}
        </div>
      </section>
      <section className="workflow-preview-config" aria-label="Retry Rules">
        <header><b>Retry Rules</b><button className="workflow-preview-toggle" type="button" role="switch"
          aria-label="Retry Rules" aria-checked={retriesEnabled} onClick={() => setRetriesEnabled((value) => !value)} /></header>
        <div className="workflow-preview-retry">
          <label>Max Retries<span>{retriesEnabled ? settings.retry.maxRetries : 'Off'}</span></label>
          {settings.retry.rest.map(([label, value]) => <label key={label}>{label}<span>{value}</span></label>)}
        </div>
      </section>
      <section className="workflow-preview-config" aria-label="Execution Conditions">
        <header><b>Execution Conditions</b><button className="workflow-preview-toggle" type="button" role="switch"
          aria-label="Execution Conditions" aria-checked={conditionsEnabled}
          onClick={() => setConditionsEnabled((value) => !value)} /></header>
        <label>Run If (expression)<code className="workflow-preview-expression">
          {conditionsEnabled ? settings.conditions.expression : 'Execution conditions disabled'}
        </code></label>
        {conditionsEnabled && <div className="workflow-preview-outcomes">
          {settings.conditions.outcomes.map(([label, value]) => <label key={label}>{label}<span>{value}</span></label>)}
        </div>}
      </section>
    </div>
  </div>;
}
