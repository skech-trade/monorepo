# infra

Where the engine and relayer run: one small Linux box (EC2, Amazon Linux 2023), Caddy in front for TLS.
The apps stay on Vercel and reach it over `wss://`.

```
app (Vercel) ──wss://<domain>/engine/ws───> Caddy :443 ──> engine  127.0.0.1:3102
             └─wss://<domain>/relayer/ws──>            └─> relayer 127.0.0.1:3103 ──> Monad
```

| File | |
|---|---|
| `setup.sh` | once per box: swap, a `skech` user, rustup, bun, Caddy, the systemd units. Safe to run again |
| `deploy.sh` | copy the source, build on the box, restart both, check `/health`. `--env` also sends the keys |
| `Caddyfile` | TLS and the two paths, on `SKECH_DOMAIN` |
| `systemd/` | `skech-engine`, `skech-relayer`, `caddy`. All restart on exit |
| `BOX.local.md` | gitignored: which box, how to get in, what is still to do on it |

## Access

The scripts reach the box as `skech`, a host in `~/.ssh/config` with its key (`*.pem` never goes in
the repo). `SKECH_HOST=<other>` points them at another entry.

```bash
ssh skech
```

## Deploy

```bash
infra/setup.sh            # a new box, or after changing the Caddyfile or a unit
infra/deploy.sh --env     # first time, or after changing a key in .env.local
infra/deploy.sh           # every other time
```

`setup.sh` serves the box's IP as an sslip.io name (`1.2.3.4` → `1-2-3-4.sslip.io`, which resolves back
to it), so no DNS is needed. `SKECH_DOMAIN=api.example.com infra/setup.sh` serves a real name instead,
once its A record points at the box. Either way ports 80 and 443 have to be open for the certificate;
3102 and 3103 never are.

`--env` writes `/etc/skech/env` (root:skech, 640) from `.env.local`, keeping only what the servers read:
`SKECH_NETWORK`, `ENGINE_PRIVATE_KEY`, `ENGINE_BAND_BPS`, `ENGINE_SENTRY_DSN`, `RELAYER_PRIVATE_KEY`, `RELAYER_SHADOW_EVERY`, `RELAYER_ENGINE_SIGNER`
and the `MONAD_*_RPC_URL`s. Nothing else in `.env.local` leaves this machine.

The engine compiles on the box, which is slow the first time (several minutes, in swap) and quick after:
`target/` stays between deploys. So do `node_modules` and the relayer's state file.

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
| bets placed but not yet settled | `/opt/skech/packages/relayer/.relayer-state.<chain>.<game>.json` | survives restarts and deploys, not losing the box: copy it off daily |
| sign-in, wallet | Coinbase CDP | Coinbase keeps it |
| session key | the player's browser, IndexedDB | the player signs in again |
| settings, practice money, scoreboard | the player's browser, local and session storage | per device on purpose |
| waitlist emails | a Google Sheet, via `WAITLIST_SHEET_URL` in `ui/landing` | kept in the Sheet |

## On the box

```bash
systemctl status skech-engine skech-relayer caddy
journalctl -u skech-engine -f                     # what it signs, once a second
journalctl -u skech-relayer -f                    # pieces placed, bars settled
curl -s localhost:3103/status                     # the relayer's sends, gas and backlog
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
