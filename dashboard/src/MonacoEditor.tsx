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

function diffLineDecorations(editor: Editor) {
  return editor.getModel()?.getLinesContent().flatMap((line, index) => {
    const className = line.startsWith('+') ? 'zenchron-diff-added-line'
      : line.startsWith('-') ? 'zenchron-diff-removed-line' : undefined;
    return className ? [{
      range: { startLineNumber: index + 1, startColumn: 1, endLineNumber: index + 1, endColumn: 1 },
      options: { isWholeLine: true, className },
    }] : [];
  }) ?? [];
}

export function MonacoEditor({ value, label, mode, readOnly, onChange, className, lineNumbers }: {
  value: string;
  label: string;
  mode: EditorMode;
  readOnly: boolean;
  onChange?: (value: string) => void;
  className: string;
  lineNumbers?: (lineNumber: number) => string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | undefined>(undefined);
  const decorations = useRef<string[]>([]);
  const valueRef = useRef(value);
  const readOnlyRef = useRef(readOnly);
  const onChangeRef = useRef(onChange);
  const lineNumbersRef = useRef(lineNumbers);
  const [loadFailed, setLoadFailed] = useState(false);
  valueRef.current = value;
  readOnlyRef.current = readOnly;
  onChangeRef.current = onChange;
  lineNumbersRef.current = lineNumbers;

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
        minimap: { enabled: mode === 'diff', renderCharacters: false },
        lineNumbers: lineNumbers ? (line) => lineNumbersRef.current?.(line) ?? '' : 'on',
        lineNumbersMinChars: lineNumbers ? 7 : 5,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontSize: 11,
        lineHeight: 17,
        wordWrap: mode === 'diff' ? 'off' : 'on',
        links: false,
      });
      editor.current = instance;
      if (mode === 'diff') decorations.current = instance.deltaDecorations([], diffLineDecorations(instance));
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
    if (mode === 'diff') {
      decorations.current = editor.current.deltaDecorations(decorations.current, diffLineDecorations(editor.current));
    }
  }, [mode, readOnly, value]);

  return <div className={className} aria-label={label} ref={container}>
    {loadFailed && <textarea className="monaco-editor-fallback" aria-label={label} value={value} readOnly={readOnly}
      onChange={(event) => onChange?.(event.currentTarget.value)} />}
  </div>;
}
