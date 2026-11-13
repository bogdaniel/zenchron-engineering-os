import { useState } from 'react';
import { Avatar } from '@mantine/core';
import { IconFileText } from '@tabler/icons-react';
import { MonacoEditor } from './MonacoEditor';
import type { PullRequestDiff, PullRequestView } from './reviewsView';

export function CodeDiff({ value, label, lineNumbers }: { value: string; label: string; lineNumbers?: (lineNumber: number) => string }) {
  return <MonacoEditor className="reviews-code-editor" label={label} mode="diff" value={value} readOnly lineNumbers={lineNumbers} />;
}

const fileHeader = /^(diff --git |index |--- |\+\+\+ )/;
/** A one-file patch is named in the bar above it, so its file headers are dropped; a longer patch keeps them. */
function readablePatch(patch: string) {
  if ((patch.match(/^diff --git /gm)?.length ?? 0) > 1) return patch;
  return patch.split('\n').filter((line) => !fileHeader.test(line)).join('\n');
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
    if (line.startsWith('diff --git ')) {
      oldLine = undefined;
      newLine = undefined;
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
  return patch.split('\n').flatMap((line) => {
    if (!line) return [];
    if (line.startsWith('@@') || line.startsWith('diff --git ')) return [{ kind: 'header', old: line, next: line }];
    if (fileHeader.test(line)) return [];
    if (line.startsWith('-')) return [{ kind: 'removed', old: line.slice(1), next: '' }];
    if (line.startsWith('+')) return [{ kind: 'added', old: '', next: line.slice(1) }];
    const context = line.startsWith(' ') ? line.slice(1) : line;
    return [{ kind: 'context', old: context, next: context }];
  });
}

/** A pull request's patch with the file bar, the Split / Unified switch, and any inline discussion. */
export function PullRequestPatch({ diff, view }: { diff: PullRequestDiff; view: NonNullable<PullRequestView['diff']> }) {
  const [layout, setLayout] = useState<'split' | 'unified'>('unified');
  const patch = diff.patch && /^@@+ /m.test(diff.patch) ? readablePatch(diff.patch) : undefined;
  return <div className="reviews-pr-diff reviews-design-diff">
    <div className="reviews-diff-meta">
      <span><IconFileText size={13} /> {view.file}</span>
      <span className="reviews-preview-diff-controls"><b>{view.added}</b><em>{view.removed}</em>
        <button type="button" aria-pressed={layout === 'split'} onClick={() => setLayout('split')}>Split</button>
        <button type="button" aria-pressed={layout === 'unified'} onClick={() => setLayout('unified')}>Unified</button></span>
    </div>
    {diff.loading ? <span>Loading pull request diff…</span>
      : diff.error ? <span className="reviews-action-error" role="alert">{diff.error.message}</span>
        : !patch ? <div className="reviews-pr-diff-empty" role="status">No readable text patch was returned. Review file changes on GitHub.</div>
          : layout === 'unified' ? <CodeDiff label="Pull request diff" value={patch} lineNumbers={sourceLineNumbers(patch)} />
            : <div className="reviews-preview-split-diff" role="region" aria-label="Split diff view">
              <div className="reviews-preview-split-head"><span>Before</span><span>After</span></div>
              {splitRows(patch).map((row, index) => row.kind === 'header'
                ? <div className="reviews-preview-split-hunk" key={index}>{row.old}</div>
                : <div className={`reviews-preview-split-row ${row.kind}`} key={index}>
                  <code>{row.old}</code><code>{row.next}</code>
                </div>)}
            </div>}
    {view.thread && <aside className="reviews-preview-thread" aria-label="Illustrative inline review discussion">
      {view.thread.map((comment) => <div key={comment.author}>
        <Avatar size={20} color={comment.color} radius="xl">{comment.initials}</Avatar>
        <p><b>{comment.author}</b><span>{comment.text}</span></p>
      </div>)}
    </aside>}
  </div>;
}
