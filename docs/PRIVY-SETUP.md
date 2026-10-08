# Turning on sign-in

The web app signs in with Privy: email, SMS, Google or Apple, and an Ethereum
wallet Privy makes for each player on their first sign-in. The code is done;
what is left is in Privy's dashboard, and none of it can be done from here.

The app is `cmuzqwmig01200dl8gf8j8tf2` at [dashboard.privy.io](https://dashboard.privy.io).
That id is the only thing the browser needs: `NEXT_PUBLIC_PRIVY_APP_ID`, in
`.env.local` and in the Vercel project. The app secret is for servers, and
nothing here uses it.

## 1. Allow the app's origins

Configuration → App settings → Domains, allowed origins. Exactly, with the
scheme and the port and no trailing slash:

```
https://app.skech.trade
http://localhost:3101
```

Do not leave localhost on the production app for good: anything running on
someone's machine could then pretend to be us. A separate development app id
is the cleaner split.

## 2. Turn on the ways in

Login methods: **Email**, **SMS**, **Google** and **Apple**. The app asks for
those four (`loginMethods` in `ui/app/src/components/app/privy.tsx`), and each
has to be on here as well.

## 3. Turn on the wallet

Embedded wallets: **Ethereum** on. The app creates one on sign-in for anyone
without a wallet, and signs with it silently: the app turns Privy's
confirmation screens off in code, whatever the dashboard says.

## Checking it worked

```bash
cd ui/app && bun run dev
```

Signed out, the corner holds Sign in. Press it and Privy's panel opens with an
email field and buttons for SMS, Google and Apple.
