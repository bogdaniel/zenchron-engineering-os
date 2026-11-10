import { Avatar } from '@mantine/core';
import { IconFileText } from '@tabler/icons-react';
import { MonacoEditor } from './MonacoEditor';

export function CodeDiff({ value, label }: { value: string; label: string }) {
  return <MonacoEditor className="reviews-code-editor" label={label} mode="diff" value={value} readOnly />;
}

export function ReviewPreviewDiff({ loading, error, patch }: { loading: boolean; error: Error | null; patch?: string }) {
  return <div className="reviews-pr-diff reviews-design-diff">
    <div className="reviews-diff-meta">
      <span><IconFileText size={13} /> src/review/evidence_capture.ts</span>
      <span className="reviews-preview-diff-controls"><b>+37</b><em>−12</em><button type="button" disabled>Split</button><button type="button" disabled>Unified</button></span>
    </div>
    {loading ? <span>Loading pull request diff…</span>
      : error ? <span className="reviews-action-error" role="alert">{error.message}</span>
        : patch && /^@@+ /m.test(patch)
          ? <CodeDiff label="Pull request diff" value={patch} />
          : <div className="reviews-pr-diff-empty" role="status">No readable text patch was returned. Review file changes on GitHub.</div>}
    <aside className="reviews-preview-thread" aria-label="Illustrative inline review discussion">
      <div><Avatar size={20} color="violet" radius="xl">AC</Avatar><p><b>Alex Chen · 32m ago</b><span>Good addition. Can we include artifact schema version for traceability?</span></p></div>
      <div><Avatar size={20} color="grape" radius="xl">MP</Avatar><p><b>Maya Patel · 29m ago</b><span>Done — added schemaVersion in the next commit (c71e3ca)</span></p></div>
    </aside>
  </div>;
}
