# Deploying

Three things ship separately:

| What | Where it runs | How it ships |
|---|---|---|
| The app (`ui/app`) and the landing (`ui/landing`) | Vercel | on merge to `main`, by itself |
| The engine and the relayer (`packages/engine`, `packages/relayer`, with `packages/core`) | the EC2 box ([infra/README.md](../infra/README.md)) | `infra/deploy.sh`, by hand |
| The contracts (`packages/contracts`) | Monad | `bun run deploy:contracts`, by hand, rarely |

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
curl -s https://api.skech.trade/relayer/status  # up: seconds since the restart; pieces, settling
```

and draw one piece on app.skech.trade.

`deploy.sh` copies the working tree, not a commit: run it from a clean `main`. The engine's Sentry
release is marked `-dirty` when it is not.

## 2. Change a key or a setting

| Setting | Where | Then |
|---|---|---|
| A server key or RPC (`ENGINE_*`, `RELAYER_*`, `MONAD_*_RPC_URL`, the Sentry DSNs) | `.env.local` | `infra/deploy.sh --env` |
| An app setting (`NEXT_PUBLIC_*`, `SENTRY_AUTH_TOKEN`) | the app's Vercel project, Production and Preview | redeploy in Vercel: they are read at build |
| The landing's app link | `NEXT_PUBLIC_APP_URL` in the landing's Vercel project | redeploy |

The full list, with what each is for, is in [.env.example](../.env.example).

## 3. A new deployment of the contracts

A new game is a new set of addresses: nothing moves across by itself. Balances, open bets, IOUs and
fees stay in the old one.

**Before**, on the old game:

1. Players withdraw what they hold (the app's Withdraw). Say so first: the new game starts empty.
2. Let every open bet settle: `settling.seconds` in `/relayer/status` reaches 0.
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
   files are per game (`.relayer-state.<chain>.<game>.json`, `.relayer-activity.…`), so it starts
   clean and the old ones are left alone.
3. Check the difficulty and the fees are what you want (`SkechGame.config()`, `difficultyOf(0)`).
   The pool starts at 0 and only fills from stakes: the first wins are paid in IOUs, which are
   paid off as it fills.
4. Check as in 1, and that `/relayer/status` names the new `chain.game`.

`SKECH_GAME` (app, relayer), `ENGINE_VERIFYING_CONTRACT` (engine) and `SKECH_DEPLOY_BLOCK` (relayer)
override the file, for a one-off; the file is what everything should agree on.

To change one contract's code without new addresses, upgrade its proxy instead: see
[packages/contracts/README.md](../packages/contracts/README.md). Balances and bets stay where they are.

## 4. A new box

[infra/README.md](../infra/README.md): `infra/setup.sh`, then `infra/deploy.sh --env`. Open 80 and
443 for the certificate, point `api.skech.trade` at it, and copy the relayer's state file across from
the old box if it had bets still open.

## 5. Going back

- **The app or the landing:** promote the previous deployment in Vercel, then revert the PR.
- **The box:** check out the last good commit and `infra/deploy.sh` from it. The relayer's state
  survives either way.
- **The contracts:** there is no going back to the old addresses once players have moved; upgrade the
  proxy with a fix instead.
