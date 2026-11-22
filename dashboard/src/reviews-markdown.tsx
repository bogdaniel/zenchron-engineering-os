import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'A') node.setAttribute('rel', 'noopener noreferrer');
});

export function GitHubMarkdown({ value, className }: { value: string; className: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(value, { async: false, gfm: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'style', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'picture', 'svg', 'math', 'img',
    ],
    FORBID_ATTR: ['style'],
  }), [value]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
