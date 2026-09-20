import { SQL } from "bun";

/**
 * Postgres, through Bun's own driver.
 *
 * Postgres because it is the one database every host has a managed version of:
 * on AWS that is RDS or Aurora Serverless, and nothing here uses an extension
 * or a type that would tie it to either. Bun's driver so there is no
 * dependency to keep up to date and no connection pool to configure.
 */

const URL_DB = process.env.DATABASE_URL ?? "";

export const hasDb = URL_DB !== "";

export const sql = hasDb ? new SQL({ url: URL_DB, max: 8, idleTimeout: 30 }) : null;

/**
 * The tables, made on boot.
 *
 * Plain `CREATE TABLE IF NOT EXISTS` rather than a migration tool: there is
 * one service and four tables, and a tool that manages that is more moving
 * parts than the thing it manages. It stops being enough the first time a
 * column has to change under live data, and that is the moment to add one.
 */
export async function migrate() {
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id            bigserial PRIMARY KEY,
      -- The wallet is the identity. Lowercased, because the same address
      -- arrives checksummed from one place and flat from another.
      address       text NOT NULL UNIQUE,
      -- What they asked to be called. Null until they say.
      name          text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      seen_at       timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS lighter_accounts (
      user_id        bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      account_index  bigint,
      api_key_index  int,
      -- Encrypted before it arrives here. This column never holds a key in
      -- the clear, whatever is convenient at the time.
      encrypted_key  text,
      status         text NOT NULL DEFAULT 'none',
      updated_at     timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS rounds (
      id           bigserial PRIMARY KEY,
      user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      market_id    int NOT NULL,
      stake        numeric(20, 6) NOT NULL,
      leverage     int NOT NULL,
      -- The drawn line, as the points that made it.
      shape        jsonb NOT NULL,
      seconds      int NOT NULL,
      status       text NOT NULL DEFAULT 'open',
      net          numeric(20, 6),
      entry        numeric(20, 2),
      exit         numeric(20, 2),
      opened_at    timestamptz NOT NULL DEFAULT now(),
      closed_at    timestamptz
    )`;
  await sql`CREATE INDEX IF NOT EXISTS rounds_by_user ON rounds (user_id, opened_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS orders (
      id          bigserial PRIMARY KEY,
      round_id    bigint NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      -- The venue's own id for this order, so a restart can reconcile rather
      -- than send it twice.
      client_id   bigint NOT NULL,
      tx_hash     text,
      side        text NOT NULL,
      size        numeric(20, 8) NOT NULL,
      price       numeric(20, 2),
      sent_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (round_id, client_id)
    )`;
}

export type User = { id: number; address: string; name: string | null };

/** The user for this wallet, made on first sight. */
export async function userFor(address: string): Promise<User | null> {
  if (!sql) return null;
  const at = address.toLowerCase();
  const [row] = await sql`
    INSERT INTO users (address) VALUES (${at})
    ON CONFLICT (address) DO UPDATE SET seen_at = now()
    RETURNING id, address, name`;
  return row as User;
}

/** What they want to be called. */
export async function rename(address: string, name: string): Promise<User | null> {
  if (!sql) return null;
  const [row] = await sql`
    UPDATE users SET name = ${name}, seen_at = now()
    WHERE address = ${address.toLowerCase()}
    RETURNING id, address, name`;
  return (row as User) ?? null;
}
