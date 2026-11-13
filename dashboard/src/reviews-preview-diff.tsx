import { useState } from 'react';
import { Avatar } from '@mantine/core';
import { IconFileText } from '@tabler/icons-react';
import { MonacoEditor } from './MonacoEditor';

export function CodeDiff({ value, label, lineNumbers }: { value: string; label: string; lineNumbers?: (lineNumber: number) => string }) {
  return <MonacoEditor className="reviews-code-editor" label={label} mode="diff" value={value} readOnly lineNumbers={lineNumbers} />;
}

function stripFileHeaders(patch: string) {
  return patch.split('\n').filter((line) => !/^(diff --git |index |--- |\+\+\+ )/.test(line)).join('\n');
}

function sourceLineNumbers(patch: string) {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const pair = (oldNumber?: number, newNumber?: number) =>
    `${oldNumber ?? '&nbsp;'.repeat(3)}&nbsp;${newNumber ?? '&nbsp;'.repeat(3)}`;
  const lines = patch.split('\n').map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return '';
    }
    if (oldLine === undefined || newLine === undefined || line.startsWith('\\')) return '';
    if (line.startsWith('-')) return pair(oldLine++);
    if (line.startsWith('+')) return pair(undefined, newLine++);
    if (line.startsWith(' ')) return pair(oldLine++, newLine++);
    return '';
  });
  return (line: number) => lines[line - 1] ?? '';
}

function splitRows(patch: string) {
  return stripFileHeaders(patch).split('\n').flatMap((line) => {
    if (!line) return [];
    if (line.startsWith('@@')) return [{ kind: 'header', old: line, next: line }];
    if (line.startsWith('-')) return [{ kind: 'removed', old: line.slice(1), next: '' }];
    if (line.startsWith('+')) return [{ kind: 'added', old: '', next: line.slice(1) }];
    const context = line.startsWith(' ') ? line.slice(1) : line;
    return [{ kind: 'context', old: context, next: context }];
  });
}

export function ReviewPreviewDiff({ loading, error, patch }: { loading: boolean; error: Error | null; patch?: string }) {
  const [view, setView] = useState<'split' | 'unified'>('unified');
  return <div className="reviews-pr-diff reviews-design-diff">
    <div className="reviews-diff-meta">
      <span><IconFileText size={13} /> src/review/evidence_capture.ts</span>
      <span className="reviews-preview-diff-controls"><b>+37</b><em>−12</em>
        <button type="button" aria-pressed={view === 'split'} onClick={() => setView('split')}>Split</button>
        <button type="button" aria-pressed={view === 'unified'} onClick={() => setView('unified')}>Unified</button></span>
    </div>
    {loading ? <span>Loading pull request diff…</span>
      : error ? <span className="reviews-action-error" role="alert">{error.message}</span>
        : patch && /^@@+ /m.test(patch)
          ? view === 'unified' ? <CodeDiff label="Pull request diff" value={stripFileHeaders(patch)}
            lineNumbers={sourceLineNumbers(stripFileHeaders(patch))} />
            : <div className="reviews-preview-split-diff" role="region" aria-label="Split diff view">
              <div className="reviews-preview-split-head"><span>Before</span><span>After</span></div>
              {splitRows(patch).map((row, index) => row.kind === 'header'
                ? <div className="reviews-preview-split-hunk" key={index}>{row.old}</div>
                : <div className={`reviews-preview-split-row ${row.kind}`} key={index}>
                  <code>{row.old}</code><code>{row.next}</code>
                </div>)}
            </div>
          : <div className="reviews-pr-diff-empty" role="status">No readable text patch was returned. Review file changes on GitHub.</div>}
    <aside className="reviews-preview-thread" aria-label="Illustrative inline review discussion">
      <div><Avatar size={20} color="violet" radius="xl">AC</Avatar><p><b>Alex Chen · 32m ago</b><span>Good addition. Can we include artifact schema version for traceability?</span></p></div>
      <div><Avatar size={20} color="grape" radius="xl">MP</Avatar><p><b>Maya Patel · 29m ago</b><span>Done — added schemaVersion in the next commit (c71e3ca)</span></p></div>
    </aside>
  </div>;
}
