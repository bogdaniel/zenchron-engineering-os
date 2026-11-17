/** Local dashboards start in Mock, so cross-page Live links must carry their mode explicitly. */
export function livePageHref(page: 'objectives' | 'workflows' | 'agents' | 'reviews',
  parameters: Record<string, string> | URLSearchParams) {
  const query = new URLSearchParams(parameters);
  query.set('mode', 'live');
  return `/?${query}#${page}`;
}
