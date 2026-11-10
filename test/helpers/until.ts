// One polling helper for the tests. It re-runs `check` until it returns a truthy value, then returns that value.
// A check that never holds fails with the timeout and a description of what was awaited.
export const UNTIL_TIMEOUT_MS = 15_000;
export const UNTIL_INTERVAL_MS = 20;

export type UntilOptions = {timeout?: number; interval?: number; what?: string};

function describe(check: () => unknown) {
  return check.toString().replace(/\s+/g, ' ').slice(0, 160);
}

// A number is the timeout in ms; an object sets any of the three options.
type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>;

export async function until<T>(check: () => T | PromiseLike<T>, opts: number | UntilOptions = {}): Promise<Truthy<Awaited<T>>> {
  const {timeout = UNTIL_TIMEOUT_MS, interval = UNTIL_INTERVAL_MS, what} = typeof opts === 'number' ? {timeout: opts} : opts;
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value as Truthy<Awaited<T>>;
    if (Date.now() >= end) throw new Error(`Timed out after ${timeout} ms waiting for ${what ?? describe(check)}`);
    await new Promise(r => setTimeout(r, interval));
  }
}

// A poller with its own interval, for a file that always polled at that rate. The optional timeout
// overrides the default; the call takes (check, timeoutMs?, what?) like the local copies it replaces.
export function untilEvery(interval: number, timeout?: number) {
  return <T>(check: () => T | PromiseLike<T>, ms?: number, what?: string): Promise<Truthy<Awaited<T>>> =>
    until(check, {interval, timeout: ms ?? timeout, what});
}
