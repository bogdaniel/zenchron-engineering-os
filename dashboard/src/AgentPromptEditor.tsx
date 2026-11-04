import { MonacoEditor } from './MonacoEditor';

export function AgentPromptEditor({ label, value, readOnly, onChange }: {
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  return <div className="agent-prompt-editor-field">
    <label>{label}</label>
    <MonacoEditor
      className="agent-prompt-editor"
      label={label}
      mode="prompt"
      value={value}
      readOnly={readOnly}
      onChange={onChange}
    />
  </div>;
}
