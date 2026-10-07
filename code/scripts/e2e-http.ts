/** One acceptance request, bounded through response-body consumption as well as headers. */
export async function json(base: string, method: string, p: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; body: any }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('HTTP timeout must be a positive integer at most 2147483647 ms');
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(base + p, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: abort.signal,
    });
    const text = await res.text();
    return { status: res.status, body: text === '' ? null : JSON.parse(text) };
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`HTTP ${method} ${p} timed out after ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
