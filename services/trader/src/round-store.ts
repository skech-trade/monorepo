import { SQL } from "bun";
import type { Round } from "./rounds";

/** Every round's record, per network, so history and results survive a restart. */
export class RoundStore {
  private readonly sql: SQL | null = process.env.DATABASE_URL ? new SQL(process.env.DATABASE_URL) : null;

  constructor(private readonly network: string) {}

  async ready() {
    if (!this.sql) throw Error("DATABASE_URL is required for durable trade results");
    await this.sql`
      CREATE TABLE IF NOT EXISTS venue_rounds (
        network    text NOT NULL,
        id         text NOT NULL,
        record     jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (network, id)
      )`;
  }

  async save(round: Round) {
    if (!this.sql) throw Error("Trade storage unavailable");
    await this.sql`
      INSERT INTO venue_rounds (network, id, record) VALUES (${this.network}, ${round.id}, ${round}::jsonb)
      ON CONFLICT (network, id) DO UPDATE SET record = excluded.record, updated_at = now()`;
  }

  async all(): Promise<Round[]> {
    if (!this.sql) return [];
    const rows: { record: Round }[] = await this.sql`SELECT record FROM venue_rounds WHERE network = ${this.network} ORDER BY updated_at DESC LIMIT 1000`;
    return rows.map((r) => r.record);
  }
}
