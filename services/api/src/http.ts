/** What every route has to check about a request before it is worth a query. */

/** An address, lowercased, or nothing. Anything that is not one is not worth a query. */
export const addressOf = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);

/**
 * A JSON body that is an object, or null. `null` and `7` are valid JSON too,
 * and reading a field off either threw where a 400 was meant.
 */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
}
