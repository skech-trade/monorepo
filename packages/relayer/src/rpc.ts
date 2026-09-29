/**
 * An HTTP transport that waits out Monad's rate limit instead of failing.
 *
 * Monad's public RPC allows 15 requests a second and answers the sixteenth
 * with JSON-RPC error -32011 ("requests limited to 15/sec"), which viem does
 * not count as retryable: it retries QuickNode's -32007 and the standard
 * -32005, not this. Unhandled, a throttled `eth_sendRawTransactionSync` fails
 * outright, the nonce it took is lost, and every piece in that second with it.
 * A throttled request was turned away before it was looked at, so sending the
 * very same bytes again is safe, even for a signed transaction.
 */
import { type BaseError, http, type HttpTransportConfig, type Transport } from "viem";

/** Waits between tries, ms: under 2.5 s in all, inside the window a placement has. */
export const BACKOFF_MS = [100, 200, 400, 800, 800] as const;

/** Monad's public RPC answers -32011; QuickNode answers HTTP 429, or -32007 "request limit reached". */
export function isRateLimited(e: unknown): boolean {
  const hit = (x: unknown): boolean => {
    const err = x as { code?: unknown; status?: unknown; details?: unknown; message?: unknown };
    if (err?.code === -32011 || err?.code === -32007 || err?.status === 429) return true;
    return /requests limited to|request limit reached|rate limit|too many requests/i.test(`${err?.details ?? ""} ${err?.message ?? ""}`);
  };
  if (hit(e)) return true;
  const walk = (e as BaseError)?.walk;
  return typeof walk === "function" ? walk.call(e, hit) !== null : false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An RPC URL fit for a log: its host, not the token a private endpoint carries in its path or query. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 || u.search ? "/…" : ""}`;
  } catch {
    return "<rpc>";
  }
}

/** `transport`, retrying what the node turned away for rate. `onThrottle` hears of each wait. */
export function patient(transport: Transport, onThrottle?: (method: string, attempt: number) => void): Transport {
  return (opts) => {
    const inner = transport(opts);
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await (inner.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
        } catch (e) {
          if (attempt >= BACKOFF_MS.length || !isRateLimited(e)) throw e;
          onThrottle?.(args.method, attempt + 1);
          await sleep(BACKOFF_MS[attempt] + Math.floor(Math.random() * 50));
        }
      }
    }) as typeof inner.request;
    return { ...inner, request };
  };
}

/** An HTTP transport for Monad: viem's, made patient with the rate limit. */
export const monadHttp = (url: string, config: HttpTransportConfig = {}, onThrottle?: (method: string, attempt: number) => void) =>
  patient(http(url, config), onThrottle);
