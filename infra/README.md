# infra

Where the engine and relayer run: one small Linux box (EC2, Amazon Linux 2023), Caddy in front for TLS.
The apps stay on Vercel and reach it over `wss://`.

```
app (Vercel) ──wss://<domain>/engine/ws───> Caddy :443 ──> engine  127.0.0.1:3102
             └─wss://<domain>/relayer/ws──>            └─> relayer 127.0.0.1:3103 ──> Monad
```

| File | |
|---|---|
| `setup.sh` | once per box: swap, the users, rustup, bun, Caddy (pinned, its SHA-256 checked), the systemd units. Safe to run again |
| `deploy.sh` | copy the committed source, build on the box, install it, restart, check `/health`. `--env` also sends the keys |
| `Caddyfile` | TLS and the paths, on `SKECH_DOMAIN`; the relayers' `/status` stays on the box |
| `systemd/` | `skech-engine`, `skech-relayer`, `skech-relayer-solana`, `caddy`, all restarting on exit; `skech-backup.timer` |
| `backup-relayer.sh` | the relayers' state files into `/var/backups/skech-relayer`, every 15 minutes |
| `BOX.local.md` | gitignored: which box, how to get in, what is still to do on it |

## Access

The scripts reach the box as `skech`, a host in `~/.ssh/config` with its key (`*.pem` never goes in
the repo). `SKECH_HOST=<other>` points them at another entry.

```bash
ssh skech
```

## Deploy

```bash
infra/setup.sh            # a new box, or after changing setup.sh; deploy.sh right after
infra/deploy.sh --env     # first time, or after changing a key in .env.local
infra/deploy.sh           # every other time, the Caddyfile and units included
```

Both ship what is committed, not the working tree: `deploy.sh` sends `git archive HEAD`, and each refuses
to run while what it would ship has changes that are not committed (a new `deployments/<chain>.json`
included).

`setup.sh` serves the box's IP as an sslip.io name (`1.2.3.4` → `1-2-3-4.sslip.io`, which resolves back
to it), so no DNS is needed. `SKECH_DOMAIN=api.example.com infra/setup.sh` serves a real name instead,
once its A record points at the box. Either way ports 80 and 443 have to be open for the certificate;
3102, 3103 and 3104 never are. The engine listens on 127.0.0.1 only; the relayers listen on every
interface, so the security group is what keeps them off the internet.

`--env` writes `/etc/skech/env` (root only, 600) from `.env.local`, keeping only what the servers read:
`SKECH_NETWORK`, the `ENGINE_*` and `RELAYER_*` settings and keys, the `MONAD_*_RPC_URL`s and the Solana
relayer's. Nothing else in `.env.local` leaves this machine. Every deploy splits it in two:
`/etc/skech/engine.env` (the `ENGINE_*` keys, readable by the engine only) and `/etc/skech/relayer.env`
(the rest, readable by the relayers only). A box without `RELAYER_PRIVATE_KEY` gets the engine's key under
that name, as the relayer would have used it anyway.

## Who runs what

| User | | Can write |
|---|---|---|
| `skech` | builds: owns rustup, bun and `/home/skech/src`, where `deploy.sh` copies the source and compiles it. Cannot sudo | its home |
| root | owns `/opt/skech`, what runs: the build copied out of `/home/skech/src`, the engine as `/opt/skech/bin/engine` | |
| `skech-engine` | the engine | nothing |
| `skech-relayer` | both relayers | `/var/lib/skech-relayer` (their state), `/var/cache/skech-relayer` (bun's cache) |
| `caddy` | Caddy, on 80 and 443 | `/var/lib/caddy` (its certificates) |

Each service runs with `ProtectSystem=strict` (the whole file system read-only but the paths above),
`ProtectHome=read-only`, a private `/tmp` and `/dev`, no capabilities (Caddy keeps the one to bind 80 and
443), only IP and unix sockets, 65536 files, and a `MemoryMax` so a leak on the 1 GB box ends in its own
service. A service that crashes 50 times in ten minutes is left stopped: `sudo systemctl reset-failed
<unit>` and start it. Caddy's admin API is a unix socket, `/run/caddy/admin.sock`, not `localhost:2019`.

The engine compiles on the box, which is slow the first time (several minutes, in swap) and quick after:
`target/` stays in `/home/skech/src` between deploys. So does `node_modules`.

Which game each serves comes from `packages/contracts/deployments/<chainId>.json`, deployed with the rest.
After a new `bun run deploy:contracts`, run `infra/deploy.sh`; the whole order, and what happens to the
old game's money, is in [docs/DEPLOYING.md](../docs/DEPLOYING.md).

The app finds them through `NEXT_PUBLIC_ENGINE_URL=wss://<domain>/engine/ws` and
`NEXT_PUBLIC_RELAYER_URL=wss://<domain>/relayer/ws`, set in its Vercel project. The app's origin also
goes in the CDP project (`docs/CDP-SETUP.md`).

## State, and why there is no database

Nothing reads a database. The `DATABASE_URL` some `.env.local` files still carry was for the Lighter services, removed on 2026-09-26.

| State | Where | If it is lost |
|---|---|---|
| balances, bets, IOUs, fees | on chain: `SkechGame`, `SkechIOU`, `SkechRevenue` | not possible to lose |
| bets placed but not yet settled | `/var/lib/skech-relayer/.relayer-state.<chain>.<game>.json` | survives restarts and deploys; backed up every 15 minutes (below) |
| sign-in, wallet | Coinbase CDP | Coinbase keeps it |
| session key | the player's browser, IndexedDB | the player signs in again |
| settings, practice money, scoreboard | the player's browser, local and session storage | per device on purpose |
| waitlist emails | a Google Sheet, via `WAITLIST_SHEET_URL` in `ui/landing` | kept in the Sheet |

## Backups

`skech-backup.timer` runs `/usr/local/sbin/skech-backup-relayer` (`backup-relayer.sh`) every 15 minutes: the
relayers' state and activity files are copied to `/var/backups/skech-relayer/<UTC time>/` (root only), and
the newest 672, a week, are kept. A copy on the same disk covers a bad deploy or a deleted file, not losing
the box. For that, `SKECH_BACKUP_S3=s3://<bucket>/<prefix>` in `/etc/skech/backup.env` also sends each one to
S3, with the aws CLI (on Amazon Linux already) and an instance role that may `s3:PutObject` there.
`SKECH_BACKUP_KEEP` and `SKECH_BACKUP_DIR` go there too.

```bash
sudo skech-backup-relayer                              # one now
systemctl list-timers skech-backup.timer               # when the next is
sudo ls /var/backups/skech-relayer | tail -3           # the newest
```

To restore one: `sudo systemctl stop skech-relayer skech-relayer-solana`, copy its files into
`/var/lib/skech-relayer/`, `sudo chown skech-relayer: /var/lib/skech-relayer/.relayer-*`, and start them.

## On the box

```bash
systemctl status skech-engine skech-relayer caddy
journalctl -u skech-engine -f                     # what it signs, once a second
journalctl -u skech-relayer -f                    # pieces placed, bars settled
curl -s localhost:3103/status                     # the relayer's sends, gas and backlog (not served publicly)
sudo systemctl restart skech-relayer
```

Keep the relayer's wallet above 12 MON: Monad holds 10 in reserve, and every transaction is charged its
gas limit. The relayer logs a warning at start when it is under.

## Cost

A t3.micro on demand is about **$12.50 a month**: the instance $8.20, the disk $0.70, a public IPv4 $3.60.
An attached Elastic IP adds nothing; one left unattached still bills. Measured on 2026-09-29: CPU about 1%
(a t3.micro can sustain 10% at no extra cost), and 1.5 KB/s out per connected player, so AWS's free
100 GB a month of outbound data covers about 17,000 player-hours. Set the instance's CPU credits to
Standard so a busy CPU slows down instead of billing.
