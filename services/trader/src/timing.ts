/**
 * How long things take, measured rather than assumed.
 *
 * Every stage between a click and a confirmed fill is logged as one JSON line
 * (`grep '"evt":"timing"'`) and kept in a small ring so `/metrics/timings`
 * can answer with percentiles. All times are this server's clock; the venue's
 * fill timestamps are on its own clock and were seen ten seconds adrift on
 * testnet, so they are never subtracted from ours.
 *
 *   open.accept        request in → round validated, before any network
 *   open.ack           request in → venue accepted the first order
 *   open.fill          request in → first fill pushed back
 *   order.ack          order sent → venue accepted it (one round trip)
 *   order.fill         order sent → its first fill pushed back
 *   order.late         order sent − the moment the plan wanted it sent
 *   close.ack          close requested → close order accepted
 *   close.flat         close requested → venue shows the position flat
 */

const RING = 500;
const samples = new Map<string, number[]>();

export function timing(metric: string, ms: number, fields: Record<string, unknown> = {}) {
  if (!Number.isFinite(ms)) return;
  const list = samples.get(metric) ?? [];
  list.push(ms);
  if (list.length > RING) list.shift();
  samples.set(metric, list);
  if (process.env.NODE_ENV !== "test") console.log(JSON.stringify({ evt: "timing", metric, ms: Math.round(ms), ...fields }));
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

export function timings() {
  const out: Record<string, { n: number; p50: number; p95: number; max: number; last: number }> = {};
  for (const [metric, list] of samples) {
    const sorted = [...list].sort((a, b) => a - b);
    out[metric] = { n: list.length, p50: Math.round(pct(sorted, 0.5)), p95: Math.round(pct(sorted, 0.95)), max: Math.round(sorted.at(-1)!), last: Math.round(list.at(-1)!) };
  }
  return out;
}
