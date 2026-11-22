export function consumeQueryParams(...keys: string[]) {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of keys) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.delete(key);
    changed = true;
  }
  if (changed) window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
