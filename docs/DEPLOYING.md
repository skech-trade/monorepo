# Deploying

Three things ship separately:

| What | Where it runs | How it ships |
|---|---|---|
| The app (`ui/app`) and the landing (`ui/landing`) | Vercel | on merge to `main`, by itself |
| The engine and the relayer (`packages/engine`, `packages/relayer`, with `packages/core`) | the EC2 box ([infra/README.md](../infra/README.md)) | `infra/deploy.sh`, by hand |
| The contracts (`packages/contracts/evm`) | Monad | `bun run deploy:contracts`, by hand, rarely |

Merging does not reach the box. A change to the engine, the relayer, `packages/core` or a
deployment file is live only after `infra/deploy.sh`.

## 1. Ship a change

From `main`, after the PR is merged:

```bash
git checkout main && git pull
infra/deploy.sh            # only if the engine, relayer, core or deployments/ changed
```

Vercel builds the app and the landing from the merge. Then check:

```bash
curl https://api.skech.trade/engine/health      # ok
curl https://api.skech.trade/relayer/health     # ok
ssh skech curl -s localhost:3103/status         # up: seconds since the restart; pieces, settling
```

and draw one piece on app.skech.trade.

`deploy.sh` ships the commit checked out, from `git archive`, and refuses to run while what it ships has
changes that are not committed. The engine's Sentry release is that commit.

## 2. Change a key or a setting

| Setting | Where | Then |
|---|---|---|
| A server key or RPC (`ENGINE_*`, `RELAYER_*`, `MONAD_*_RPC_URL`, the Sentry DSNs) | `.env.local` | `infra/deploy.sh --env` |
| Where the backups go (`SKECH_BACKUP_S3`, `SKECH_BACKUP_KEEP`) | `/etc/skech/backup.env` on the box | the next backup reads it |
| An app setting (`NEXT_PUBLIC_*`, `SENTRY_AUTH_TOKEN`) | the app's Vercel project, Production and Preview | redeploy in Vercel: they are read at build |
| The landing's app link | `NEXT_PUBLIC_APP_URL` in the landing's Vercel project | redeploy |

The full list, with what each is for, is in [.env.example](../.env.example).

## 3. A new deployment of the contracts

A new game is a new set of addresses: nothing moves across by itself. Balances, open bets, IOUs and
fees stay in the old one.

**Before**, on the old game:

1. Players withdraw what they hold (the app's Withdraw). Say so first: the new game starts empty.
2. Let every open bet settle: `settling.seconds` in the relayer's `/status` (`ssh skech curl -s localhost:3103/status`) reaches 0.
3. Take the fees out of `SkechRevenue` (its `TREASURER_ROLE` is the deployer's):
   ```bash
   cast send <revenue> 'withdraw(address,address,uint256)' <usdc> <to> <amount> --private-key <admin> --rpc-url <rpc>
   ```

**Deploy:**

```bash
bun run deploy:contracts --dry-run     # gas and addresses; nothing sent, nothing written
bun run deploy:contracts               # needs ~14 MON on the deployer: Monad keeps 10 in reserve
```

It writes `packages/contracts/deployments/<chainId>.json`: the game, the IOU, the revenue, the USDC,
and the block it went out in (where the relayer counts transactions from). On mainnet it also needs
`--mainnet`.

**After:**

1. Commit `deployments/<chainId>.json` and merge it: the app reads it at build, so Vercel picks the
   new game up from the merge.
2. `infra/deploy.sh`: the engine signs for the new game and the relayer places on it. Its state
   files are per game (`/var/lib/skech-relayer/.relayer-state.<chain>.<game>.json`, `.relayer-activity.…`),
   so it starts clean and the old ones are left alone.
3. Check the difficulty and the fees are what you want (`SkechGame.config()`, `difficultyOf(0)`).
   The pool starts at 0 and only fills from stakes: the first wins are paid in IOUs, which are
   paid off as it fills.
4. Check as in 1, and that the relayer's `/status` names the new `chain.game`.

`SKECH_GAME` (app, relayer), `ENGINE_VERIFYING_CONTRACT` (engine) and `SKECH_DEPLOY_BLOCK` (relayer)
override the file, for a one-off; the file is what everything should agree on.

To change one contract's code without new addresses, upgrade its proxy instead: see
[packages/contracts/evm/README.md](../packages/contracts/evm/README.md). Balances and bets stay where they are.

## Solana

The game on Solana is its own program (`packages/contracts/solana`), its own relayer process (`packages/relayer/src/solana`, port 3104, `wss://…/solana/ws` on the box) and the mobile app. The engine is shared.

1. **Deploy the program and set the game up**, once per cluster: `bun run deploy:solana` (devnet by default; `--mainnet` for mainnet-beta). It writes `packages/contracts/deployments/solana-<cluster>.json`; commit it. The deployer needs about 5 SOL for the program's rent; devnet SOL is free from `solana airdrop` or faucet.solana.com.
2. **Give the relayer its key and SOL.** `SOLANA_RELAYER_KEYPAIR` locally, or `SOLANA_RELAYER_SECRET_KEY` (the 64 bytes as JSON) in `.env.local` for the box, plus `SKECH_SOLANA_CLUSTER`. Its key must be the game's oracle: the deploy uses `SOLANA_RELAYER_KEYPAIR`'s. It pays every fee and every rent (a bet's comes back when it settles): keep 1 SOL or more in it.
3. **Ship it**: `infra/deploy.sh --env`. With both Solana keys in the box's env, the Solana relayer starts beside the Monad one; without them it stays off.
4. **Check it**: `ssh skech curl -s localhost:3104/status`.

Locally: a validator (`solana-test-validator --reset --gossip-port 8110 --dynamic-port-range 8111-8140`, off port 8000, which Docker holds), `SKECH_SOLANA_CLUSTER=localnet bun run deploy:solana`, then `bun packages/relayer/scripts/e2e-solana.ts` plays the whole game through the relayer.

## 4. A new box

[infra/README.md](../infra/README.md): `infra/setup.sh`, then `infra/deploy.sh --env`. Open 80 and
443 for the certificate, point `api.skech.trade` at it, and copy the relayer's state files across from
the old box (`/var/lib/skech-relayer`, or its newest backup) if it had bets still open.

## 5. Going back

- **The app or the landing:** promote the previous deployment in Vercel, then revert the PR.
- **The box:** check out the last good commit and `infra/deploy.sh` from it. The relayer's state
  survives either way.
- **The contracts:** there is no going back to the old addresses once players have moved; upgrade the
  proxy with a fix instead.
