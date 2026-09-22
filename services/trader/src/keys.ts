import { SQL } from "bun";
import { Lighter } from "./lighter";
import { generateApiKey, Signer } from "./signer";
import { timing } from "./timing";

/**
 * A trading key per wallet.
 *
 * Without this the trader holds one key for one account and every round lands
 * there, so somebody watching their own balance sees it sit still while their
 * orders fill on somebody else's. That is not a limitation to explain, it is
 * the wrong thing.
 *
 * Lighter's own design is the way out. An account can carry several API keys,
 * each at an index, and registering one is a transaction the account's owner
 * authorises with the Ethereum wallet that owns it. So: make a key, ask the
 * wallet to sign the registration, keep the private half, and sign that
 * person's rounds with it. We never hold anything that can move their money
 * off the venue, only something that can trade it.
 *
 * The key index is ours to pick and has to be one nobody else is using.
 */

/** Which slot skech registers into. Zero is what most clients take first. */
export const KEY_INDEX = Number(process.env.LIGHTER_USER_KEY_INDEX ?? 2);

export type Registration = {
  address: string;
  accountIndex: number;
  apiKeyIndex: number;
  /** What the wallet has to sign, word for word. */
  messageToSign: string;
  txInfo: string;
};

export type Registered = { accountIndex: number; apiKeyIndex: number; privateKey: string };

const url = process.env.DATABASE_URL ?? "";
const sql = url ? new SQL({ url, max: 4, idleTimeout: 30 }) : null;

/**
 * Where the keys live.
 *
 * Postgres when there is one, so a restart does not ask everybody to sign
 * again. Memory otherwise, which works and says so, because a trader that
 * refuses to start without a database is a trader nobody can try.
 */
export class Keys {
  private readonly held = new Map<string, Registered>();
  /** Registrations signed and waiting for a wallet signature, by address. */
  private readonly pending = new Map<string, Registration & { privateKey: string; publicKey: string }>();

  constructor(
    private readonly venue: Lighter,
    private readonly chainId: number,
    private readonly url: string,
  ) {}

  /*
    Whether keys actually survive a restart, which is not the same as whether
    a DATABASE_URL was set. It said "postgres" while Postgres was refusing
    connections, and the one thing this flag exists to answer is whether
    everybody has to sign again after a restart.
  */
  private stored = false;

  get persistent() {
    return this.stored;
  }

  async ready() {
    if (!sql) return;
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS trader_keys (
          address       text PRIMARY KEY,
          account_index bigint NOT NULL,
          api_key_index int NOT NULL,
          private_key   text NOT NULL,
          created_at    timestamptz NOT NULL DEFAULT now()
        )`;
      this.stored = true;
    } catch (e) {
      console.error(`keys: no database, holding them in memory only (${(e as Error).message.slice(0, 90)})`);
    }
  }

  /** The key for a wallet, if it has one. */
  async forAddress(address: string): Promise<Registered | null> {
    const at = address.toLowerCase();
    const held = this.held.get(at);
    if (held) return held;
    if (!sql || !this.stored) return null;
    const rows = (await sql`SELECT account_index, api_key_index, private_key FROM trader_keys WHERE address = ${at}`.catch(() => [])) as {
      account_index: string | number;
      api_key_index: number;
      private_key: string;
    }[];
    const row = rows[0];
    if (!row) return null;
    const found = { accountIndex: Number(row.account_index), apiKeyIndex: row.api_key_index, privateKey: row.private_key };
    this.held.set(at, found);
    return found;
  }

  /**
   * Step one: make a key and sign its registration.
   *
   * The new key signs its own registration, which proves whoever asks holds
   * it; the wallet's signature, which comes next, proves they own the account.
   * Neither alone is enough, which is why the transaction carries both.
   */
  async prepare(address: string): Promise<Registration> {
    const at = address.toLowerCase();
    const account = await this.venue.accountForAddress(at);
    if (account === null) throw new Error("this wallet has no Lighter account yet");

    const key = generateApiKey();
    const signer = Signer.open({
      url: this.url,
      privateKey: key.privateKey,
      chainId: this.chainId,
      accountIndex: account,
      apiKeyIndex: KEY_INDEX,
      check: false,
    });
    const signed = signer.changePubKey(key.publicKey);
    const out: Registration = {
      address: at,
      accountIndex: account,
      apiKeyIndex: KEY_INDEX,
      messageToSign: signed.messageToSign,
      txInfo: signed.txInfo,
    };
    this.pending.set(at, { ...out, privateKey: key.privateKey, publicKey: key.publicKey });
    return out;
  }

  /**
   * Step two: the wallet has signed, so send it and keep the key.
   *
   * The signature goes into the `L1Sig` the signer left empty. Nothing here
   * can produce it, which is the point: without the account's owner agreeing,
   * this key registers against nothing.
   */
  async register(address: string, signature: string): Promise<Registered> {
    const at = address.toLowerCase();
    const waiting = this.pending.get(at);
    if (!waiting) throw new Error("nothing was prepared for this wallet");

    const tx = JSON.parse(waiting.txInfo) as Record<string, unknown>;
    tx.L1Sig = signature;
    await this.venue.send(8, JSON.stringify(tx));

    /*
      The venue takes a few seconds to accept a new key, and until it has,
      opening a signer with it fails its own check. Registering and then
      immediately refusing to trade, with "no trading key for this wallet",
      is the least helpful possible answer, so this waits for the venue to
      agree before saying the key is theirs.
    */
    /*
      Asked of the venue's key list, every quarter second, over ordinary
      async HTTP. It used to open a signer every second and a half, and that
      check is a synchronous network call inside the signer: a third of a
      second of the whole trader frozen, other people's turns included, on
      every attempt.
    */
    const started = Date.now();
    let accepted = false;
    while (Date.now() - started < 20_000) {
      await Bun.sleep(250);
      const listed = await fetch(`${this.url}/api/v1/apikeys?account_index=${waiting.accountIndex}&api_key_index=${waiting.apiKeyIndex}`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json() as Promise<{ api_keys?: { public_key?: string }[] }>)
        .catch(() => null);
      // The signer writes keys with 0x; the venue lists them without.
      const want = waiting.publicKey.toLowerCase().replace(/^0x/, "");
      if (listed?.api_keys?.some((k) => k.public_key?.toLowerCase().replace(/^0x/, "") === want)) {
        accepted = true;
        break;
      }
    }
    if (!accepted) throw new Error("the venue has not accepted the key yet; try again in a moment");
    timing("key.accepted", Date.now() - started, { account: waiting.accountIndex });

    const held: Registered = { accountIndex: waiting.accountIndex, apiKeyIndex: waiting.apiKeyIndex, privateKey: waiting.privateKey };
    this.held.set(at, held);
    this.pending.delete(at);
    if (sql && this.stored) {
      await sql`
        INSERT INTO trader_keys (address, account_index, api_key_index, private_key)
        VALUES (${at}, ${held.accountIndex}, ${held.apiKeyIndex}, ${held.privateKey})
        ON CONFLICT (address) DO UPDATE SET account_index = EXCLUDED.account_index, api_key_index = EXCLUDED.api_key_index, private_key = EXCLUDED.private_key
      `.catch(() => undefined);
    }
    return held;
  }
}
