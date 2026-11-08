// Browser module; the server only needs the usage summary it sends in /api/state.
export function usageSummary(usage: unknown[] | null | undefined): {mode: string; calls: number; input: number; output: number; unknown: number}[];
