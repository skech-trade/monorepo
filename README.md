# skech

Bun-workspaces monorepo.

## Layout

```
.
├── package.json          # workspace root (workspaces: ui/*)
├── bunfig.toml           # hoisted install linker
├── tsconfig.base.json    # shared TS compiler options
└── ui/
    ├── landing/          # @skech/landing — marketing site
    └── app/              # @skech/app     — product app
```

Both apps are Next.js 16 (App Router, TypeScript, Tailwind v4, ESLint, Turbopack)
with the `@/*` import alias pointing at each app's `src/`.

## Getting started

```bash
bun install          # install every workspace from the root
bun run dev          # run landing + app together
bun run dev:landing  # landing on its own
bun run dev:app      # app on its own
```

## Ports

Both apps use fixed default ports for `dev` and `start`:

- Landing: http://localhost:3100
- App: http://localhost:3101

Stop an existing server before restarting it. Keep `http://localhost:3101`
in your Coinbase CDP development project's allowed origins.

To override a port for an individual app, set `PORT`:

```bash
PORT=3000 bun run dev:landing
```

Leave `PORT` unset when running `bun run dev` or `bun run start` for the whole
monorepo so the two apps use different ports.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | dev server for every workspace, in parallel |
| `bun run build` | production build for every workspace |
| `bun run start` | serve the production builds |
| `bun run lint` | ESLint across every workspace |
| `bun run typecheck` | `tsc --noEmit` across every workspace |
| `bun run clean` | remove `node_modules` and `.next` |

`typecheck` relies on the route types Next generates, so run `bun run build`
(or `bun run dev`) at least once in a fresh checkout before it will pass.

## Docs

| Doc | What it covers |
| --- | --- |
| [docs/TRADING.md](docs/TRADING.md) | how a drawn line becomes a real position, and the guards that must not be removed |
| [docs/TESTNET.md](docs/TESTNET.md) | what is real on testnet, what cannot follow it there, and how to switch |
| [docs/LIGHTER-VERIFIED.md](docs/LIGHTER-VERIFIED.md) | what was read off the live venue rather than a spec |
| [docs/CDP-SETUP.md](docs/CDP-SETUP.md) | Coinbase embedded wallets, and the portal page with three names |
| [docs/VERCEL.md](docs/VERCEL.md) | the env the app needs, and the three things that are not env |
| [docs/HOSTING.md](docs/HOSTING.md) | running all of it for free on testnet, and when to stop |
| [docs/BOOSTED-ROUNDS.md](docs/BOOSTED-ROUNDS.md) | skech's money behind the user's: the maths, per coin, and what it risks |

## Adding a workspace

Anything dropped in `ui/`, `services/` or `packages/` is picked up
automatically. Depend on one as `"@skech/<name>": "workspace:*"`.
`packages/core` is the example: the drawn-shape model and the venue's numbers,
imported by both the browser and the trader so they cannot disagree about what
a line means.
