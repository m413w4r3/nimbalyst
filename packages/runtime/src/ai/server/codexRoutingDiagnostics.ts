export interface CodexRoutingSnapshot {
  model: string | null;
  provider: string | null;
  profile: string | null;
  reasoningEffort: string | null;
}

/** Log only safe Codex routing metadata when explicitly enabled for debugging. */
export function logCodexRoute(event: string, details: Record<string, unknown>): void {
  if (process.env.NIMBALYST_CODEX_ROUTE_DEBUG !== '1') {
    return;
  }
  console.log(`[CODEX ROUTE] ${event}`, details);
}
