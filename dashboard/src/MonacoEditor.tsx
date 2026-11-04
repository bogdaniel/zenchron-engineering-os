import { useEffect, useRef, useState } from 'react';

type EditorMode = 'diff' | 'prompt';
type Editor = import('monaco-editor/editor/editor.api.js').editor.IStandaloneCodeEditor;

let monacoConfigured = false;

function configureMonaco(monaco: typeof import('monaco-editor/editor/editor.api.js')) {
  if (monacoConfigured) return;
  monaco.languages.register({ id: 'zenchron-diff' });
  monaco.languages.setMonarchTokensProvider('zenchron-diff', {
    tokenizer: { root: [
      [/^\+.*/, 'diff-added'], [/^-.*/, 'diff-removed'], [/^@@.*/, 'diff-header'], [/^diff --git.*/, 'diff-header'],
    ] },
  });
  monaco.editor.defineTheme('zenchron-diff', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'diff-added', foreground: '7de4aa', background: '123222' },
      { token: 'diff-removed', foreground: 'ff9a9a', background: '3a1b24' },
      { token: 'diff-header', foreground: 'c39bff' },
    ],
    colors: { 'editor.background': '#10141a', 'editorGutter.background': '#10141a' },
  });
  monaco.editor.defineTheme('zenchron-prompt', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: {
      'editor.background': '#10141a', 'editorGutter.background': '#10141a',
      'editorLineNumber.foreground': '#77738d', 'editorLineNumber.activeForeground': '#d0c5e4',
    },
  });
  monacoConfigured = true;
}

export function MonacoEditor({ value, label, mode, readOnly, onChange, className }: {
  value: string;
  label: string;
  mode: EditorMode;
  readOnly: boolean;
  onChange?: (value: string) => void;
  className: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | undefined>(undefined);
  const valueRef = useRef(value);
  const readOnlyRef = useRef(readOnly);
  const onChangeRef = useRef(onChange);
  const [loadFailed, setLoadFailed] = useState(false);
  valueRef.current = value;
  readOnlyRef.current = readOnly;
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let instance: Editor | undefined;
    let changeSubscription: { dispose(): void } | undefined;
    void import('monaco-editor/editor/editor.api.js').then((monaco) => {
      if (disposed || !container.current) return;
      configureMonaco(monaco);
      instance = monaco.editor.create(container.current, {
        value: valueRef.current,
        language: mode === 'diff' ? 'zenchron-diff' : 'plaintext',
        theme: mode === 'diff' ? 'zenchron-diff' : 'zenchron-prompt',
        ariaLabel: label,
        readOnly: readOnlyRef.current,
        minimap: { enabled: false },
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontSize: 11,
        lineHeight: 17,
        wordWrap: mode === 'diff' ? 'off' : 'on',
        links: false,
      });
      editor.current = instance;
      changeSubscription = instance.onDidChangeModelContent(() => onChangeRef.current?.(instance!.getValue()));
    }).catch(() => {
      if (!disposed) setLoadFailed(true);
    });
    return () => {
      disposed = true;
      changeSubscription?.dispose();
      instance?.dispose();
      if (editor.current === instance) editor.current = undefined;
    };
  }, [label, mode]);

  useEffect(() => {
    if (!editor.current) return;
    if (editor.current.getValue() !== value) editor.current.setValue(value);
    editor.current.updateOptions({ readOnly });
  }, [readOnly, value]);

  return <div className={className} aria-label={label} ref={container}>
    {loadFailed && <textarea className="monaco-editor-fallback" aria-label={label} value={value} readOnly={readOnly}
      onChange={(event) => onChange?.(event.currentTarget.value)} />}
  </div>;
}
