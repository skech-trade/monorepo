# Deploying the app on Vercel

Two Next apps live here. `ui/app` is the product and `ui/landing` is the
marketing page, and they are separate Vercel projects with separate root
directories. The services are Docker and go somewhere else, which is the
whole reason the app needs their URLs handed to it.

## ui/app

```
NEXT_PUBLIC_SKECH_NETWORK=testnet
NEXT_PUBLIC_CDP_PROJECT_ID=029972f7-032e-41c1-96c7-1eb64355e499
NEXT_PUBLIC_API_URL=https://api.your-domain.com
NEXT_PUBLIC_FEED_URL=https://feed.your-domain.com
```

Four names, all of them public by design: the project id identifies the CDP
app to Coinbase's own panel, and the two URLs are called from the browser.
There is no secret in this project, and nothing server-side. If you find
yourself pasting `CDP_API_KEY_SECRET` or a Lighter private key in here, stop:
those belong to the services.

`NEXT_PUBLIC_CDP_CLIENT_API_KEY` is in `.env.local` and is not read by
anything. It is left there because the CDP portal hands it to you next to the
project id and it is easy to think it is needed.

**The network name is one name.** `NEXT_PUBLIC_SKECH_NETWORK` decides the
badge, the market id, the minimum order size and the liquidation maths, and
`SKECH_NETWORK` decides the same things in the services. Set them to the same
thing or the app will quote one venue while the API answers for another.

## ui/landing

```
WAITLIST_SHEET_URL=<the Apps Script endpoint>
```

Server-side, deliberately not `NEXT_PUBLIC_`: it is a URL anybody who finds it
can post to.

## Three things that are not environment variables

**The origin has to be allowlisted with Coinbase.** Add the Vercel domain,
production and any preview domain you actually use, at
https://portal.cdp.coinbase.com/wallets/non-custodial/clients. Without it,
signing in fails with "Failed to get project config", which reads like a
broken build rather than a missing entry.

**The API has to allow the origin.** Set `ALLOW_ORIGIN` on the API service to
the Vercel origin rather than leaving it `*` once there is real money behind
it.

**The services need TLS.** The browser calls them directly from an https page,
so an `http://` URL is blocked as mixed content and the app comes up with no
prices, no balance and no deposits, silently.

## The root env file does not apply here

`next.config.ts` pulls `NEXT_PUBLIC_` names out of the repo-root `.env.local`,
because Next only looks in its own directory and a monorepo root file is
invisible to it. On Vercel there is no such file, the loader finds nothing,
and Vercel's own variables are used as normal. A value already in the
environment wins either way, so there is nothing to undo before deploying.
