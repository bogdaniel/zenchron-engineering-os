import { useId } from 'react';
import { MonacoEditor } from './MonacoEditor';

export function AgentPromptEditor({ label, value, readOnly, onChange }: {
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const labelID = useId();
  return <div className="agent-prompt-editor-field">
    <span id={labelID}>{label}</span>
    <MonacoEditor
      className="agent-prompt-editor"
      label={label}
      labelledBy={labelID}
      mode="prompt"
      value={value}
      readOnly={readOnly}
      onChange={onChange}
    />
  </div>;
}
