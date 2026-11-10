import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function GitHubMarkdown({ value, className }: { value: string; className: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(value, { async: false, gfm: true }), {
    FORBID_TAGS: ['img'],
  }), [value]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
