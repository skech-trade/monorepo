# Hosting it for free

Written 2026-09-22. Free tiers change often; every number below was read off the
provider's own page on that date, and the ones marked *verify* were not.

This is a testnet plan. It stops being the right plan the day real money is behind
it: see [When to stop](#when-to-stop-being-free).

## Where things stand

- One Vercel project, `skech` (https://skech-pi.vercel.app). Its root directory is
  `.`, its framework preset is "Other", it has no environment variables, and it is
  serving the old "Trace — draw a trade (concept prototype)" page. Neither `ui/app`
  nor `ui/landing` is deployed.
- No database is attached to it, and the local `DATABASE_URL` points at the compose
  Postgres on :5440.
- feed, api and trader have never run anywhere but a laptop.

## The shape

| Piece | Where | Cost |
|---|---|---|
| `ui/app` | Vercel Hobby, the existing `skech` project, re-pointed | 0 |
| `ui/landing` | Vercel Hobby, a second project | 0 |
| feed, api, trader | one Oracle Cloud Always Free Ampere A1 VM, Tokyo home region, `docker compose` | 0 |
| Postgres | the compose `db` service on that same VM | 0 |
| TLS | Caddy on the VM, Let's Encrypt, `sslip.io` hostnames | 0 |

```
browser ──https──> skech-pi.vercel.app                 (Vercel: pages only)
   │
   ├──wss/https──> feed.<ip>.sslip.io   ─┐
   ├──https──────> api.<ip>.sslip.io    ─┼─ Caddy :443 ─> feed:3210 / api:3230 / trader:3220
   └──https/sse──> trader.<ip>.sslip.io ─┘                      │
                                                     db:5432 (never published)
feed ──wss──> Lighter mainnet stream        trader/api ──https──> Lighter (testnet)
```

The browser calls the three services directly, which is already how the app is
built (`NEXT_PUBLIC_*_URL`). Nothing is proxied through Vercel: WebSocket upgrades
do not survive a Vercel rewrite, and it would spend the Hobby transfer allowance.

## Why one VM, and why Oracle

All three services have to be on all the time, and that rules out most free tiers:

- the **feed** holds a socket to Lighter and keeps 1,200 bars in memory, so a sleep
  empties the chart;
- the **trader** runs rounds on per-second timers and has to close them "even if the
  tab is gone";
- the **api** scores predictions on a 3-second `setInterval`.

| Option | Why not |
|---|---|
| Render free | spins down after 15 minutes with no inbound traffic; free Postgres expires after 30 days |
| Koyeb free | one instance, 0.1 vCPU / 512 MB, Frankfurt or Washington only, scales to zero after an hour |
| Fly.io | no free tier; the trial is 2 VM-hours or 7 days |
| Railway | $1/month of credit after the trial, which cannot keep one service up for a month |
| Zeabur free | sleeps when idle |
| Northflank sandbox | two services with no sleeping, but we need three plus a database, it needs a card, and it says "not for production". Free region and specs: *verify* |
| GCP e2-micro | US regions only, and 1 GB/month of egress. The feed streams to every browser |
| AWS Free plan | $100 plus up to $100 more in credit, but only for 6 months, and then **the account closes**. A public IPv4 is $0.005/h. Keep it as the fallback |

**Oracle Always Free**, read 2026-09-22:

- A1 allows 2 OCPU / 12 GB in total. Posts that say 4 / 24 are out of date.
- 200 GB of block storage and 10 TB/month of egress.
- Arm64, which the trader already handles: `fetch-signer.sh` picks
  `lighter-signer-linux-arm64.so` on `Linux-aarch64`, and the bun images are
  multi-arch.
- Tokyo (`ap-tokyo-1`) can be the home region, which is where Lighter says to put
  things (PLAN.md §1.4).
- Always Free VMs exist only in the home region, and **the home region cannot be
  changed after sign-up**. Pick Tokyo at sign-up.

A1 has two known risks:

- **"Out of host capacity."** Tokyo can be sold out at the moment you try. Retry in
  another availability domain, retry later, or upgrade the account to Pay As You Go.
  Oracle's own page suggests PAYG, and it states that Always Free resources are
  still not charged after the upgrade.
- **Idle reclamation.** An instance counts as idle if, over 7 days, 95th-percentile
  CPU, network and (on A1) memory are all under 20%. This stack is light enough to
  look idle. Two things help:
  - size the VM at 1 OCPU / 6 GB, not the full 2 / 12, so the same load is a larger
    share of it;
  - upgrade to PAYG. That PAYG accounts are exempt from reclamation is widely
    reported but not on Oracle's page (*verify*).

  Either way, keep backups off the box (step 6), so a reclaimed VM costs an hour and
  not the data.

**Why Postgres on the VM rather than a managed free one:**

- It sits next to the api and trader, and compose already defines it.
- Neon has no Tokyo region (nearest is Singapore), always scales to zero on Free, and
  allows 0.5 GB.
- Supabase has Tokyo but pauses projects after a week of inactivity.

What we give up is managed backups, and step 6 replaces them.

## Steps

### 1. Fix the Vercel app (do this today, needs nothing else)

1. In the `skech` project settings:
   - Root Directory: `ui/app`
   - Framework Preset: Next.js
   - Leave "Include files outside the root directory" on. The app imports
     `@skech/core` from `packages/`.
2. Env, per [VERCEL.md](VERCEL.md): `NEXT_PUBLIC_SKECH_NETWORK=testnet` and
   `NEXT_PUBLIC_CDP_PROJECT_ID`. Leave the three service URLs out for now. The app
   says plainly that it has no feed.
3. Add `https://skech-pi.vercel.app` to the CDP Portal's allowed domains, or sign-in
   fails with "Failed to get project config".
4. Create a second project for the landing page: root `ui/landing`, Next.js,
   `WAITLIST_SHEET_URL`.

### 2. The VM

1. Create an Oracle Cloud account with the **Tokyo** home region.
2. Create an instance:
   - shape `VM.Standard.A1.Flex`, 1 OCPU / 6 GB
   - image Ubuntu 24.04 (aarch64)
   - 50 GB boot volume
   - reserve the public IP so it survives a stop
3. Open 80 and 443 in two places:
   - the subnet's security list;
   - the instance's own iptables. Oracle's Ubuntu images ship REJECT rules, so add
     ACCEPT rules above them, then run `netfilter-persistent save`. Missing this is
     the usual reason a correct Caddy setup never gets a certificate.
4. Install Docker Engine and the compose plugin, clone the repo, and add a 2 GB swap
   file for the trader's `gcc` build stage.

### 3. What to add to the repo

These files do not exist yet:

- **`deploy/compose.prod.yml`**, an overlay on the existing `docker-compose.yml`.
  It:
  - takes `trader` out of the `trade` profile so it always starts;
  - stops publishing the services' ports to the host (only Caddy listens);
  - adds a `caddy` service on 80/443 with a volume for its certificates;
  - sets `ALLOW_ORIGIN` from the env file.
- **`deploy/Caddyfile`**:

  ```
  feed.{$HOST}   { reverse_proxy feed:3210 }
  api.{$HOST}    { reverse_proxy api:3230 }
  trader.{$HOST} { reverse_proxy trader:3220 }
  ```

  Caddy passes WebSocket upgrades through as is, and flushes `text/event-stream`
  responses immediately, so the feed's `/ws` and the trader's round events need
  nothing extra. `HOST` is the IP in sslip.io form, e.g. `203-0-113-7.sslip.io`.
- **`deploy/backup.sh`**, a nightly `pg_dump` from cron (step 6).

### 4. The env file on the VM

`/srv/skech/.env.prod`, mode 600, never in git:

```
SKECH_NETWORK=testnet
ALLOW_ORIGIN=https://skech-pi.vercel.app
HOST=203-0-113-7.sslip.io
LIGHTER_ACCOUNT_INDEX=...
LIGHTER_API_KEY_INDEX=4
LIGHTER_PRIVATE_KEY=...        # testnet key only, see below
POSTGRES_PASSWORD=<long random> # and DOCKER_DATABASE_URL to match
```

Replace the compose default password `skech`. The `db` port is not published, but
there is no reason to keep the default.

Then start it:

```
docker compose -f docker-compose.yml -f deploy/compose.prod.yml \
  --env-file .env.prod up -d --build
```

Check that `https://feed.<host>/health`, `https://api.<host>/health` and
`https://trader.<host>/health` all answer `ok`.

### 5. Point the app at it

In the Vercel `skech` project:

```
NEXT_PUBLIC_FEED_URL=https://feed.<host>
NEXT_PUBLIC_API_URL=https://api.<host>
NEXT_PUBLIC_TRADER_URL=https://trader.<host>
```

Then **redeploy**: `NEXT_PUBLIC_` values are baked in at build time, so saving them
changes nothing until the next build.

### 6. Keep it alive

- **Backups:**
  - nightly `pg_dump | gzip`, keeping 7 days on the block volume;
  - a copy off the box to Oracle Object Storage or Cloudflare R2, both of which
    have a free allowance (*verify* sizes).
  - `trader_keys` holds the per-wallet keys, encrypted. They can be re-registered,
    but users would have to sign again.
- **Monitoring:** a free uptime checker on the three `/health` URLs. The feed's
  `ok` goes false when bars stop arriving, which is the failure that matters.
- **Deploys:** `ssh`, `git pull`, then the compose command from step 4. A GitHub
  Action doing the same over SSH is the obvious next step and costs nothing.

## Known limits of this setup

- **One box.** A reboot or deploy drops the feed's 10 minutes of history and pauses
  running rounds. Round records are durable in `venue_rounds`.
- **`ALLOW_ORIGIN` is one origin.** Preview deployments are refused by the api, the
  trader and the feed's `/ws`. That is fine for now; the fix is an allowlist, not `*`.
- **sslip.io is shared.** Its Let's Encrypt limit is shared with every other user
  (raised to 250,000/week). A real domain is about $10 a year and is the first thing
  worth paying for.
- **The feed is mainnet data from Tokyo.** The VM being in Tokyo matters for the
  trader's round trips more than for the chart.

## When to stop being free

Any one of these ends this plan:

- **A mainnet key.** PLAN.md puts it in a secrets manager, decrypted inside the
  trader. A `.env` file on a free VM that Oracle can reclaim is not that.
- **Taking money.** Vercel Hobby is non-commercial only, and that covers payments
  and ads.
- **Needing the trader never to drop a round.** That needs more than one box.

At that point PLAN.md's target applies:

- AWS Tokyo `ap-northeast-1a` for the services;
- RDS or Aurora for Postgres (the schema does not care which);
- Vercel Pro for the pages.
