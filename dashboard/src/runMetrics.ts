export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function runsInLast30Days<T extends { created_at: string }>(runs: T[], now = Date.now()) {
  const start = now - THIRTY_DAYS_MS;
  return runs.filter(({ created_at }) => {
    const createdAt = Date.parse(created_at);
    return createdAt >= start && createdAt <= now;
  });
}
