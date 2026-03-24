export function formatDuration(secs: number | null | undefined): string {
  if (secs == null || isNaN(secs)) return "-";
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h}h ${m}m ${s}s`;
  }
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
  }
  return `${secs}s`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(cost: number | null | undefined): string {
  if (cost == null || isNaN(cost)) return "-";
  return `$${cost.toFixed(2)}`;
}
