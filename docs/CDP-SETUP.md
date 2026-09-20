# Turning on sign-in

The code is done. What is left is three switches in Coinbase's portal, and
none of them can be done from here.

Both pages sit under the same project, so pick the project first at
[portal.cdp.coinbase.com](https://portal.cdp.coinbase.com). Ours is
`029972f7-032e-41c1-96c7-1eb64355e499`.

## 1. Allow the app's origin

Go straight to
**https://portal.cdp.coinbase.com/wallets/non-custodial/clients**

That page is the one the docs call Clients Configuration, Domains
Configuration and Embedded Wallet Configuration in three different places,
which is why it is hard to find by name. The button on it says **Add domain**
or **Add origin** depending on the week.

Add, exactly, with the scheme and the port and no trailing slash:

```
http://localhost:3101
```

It takes effect on save. Until it is there the SDK logs `Failed to get
project config` and the panel inside our sign-in dialog is blank, which is
what you are looking at now.

Add the real origin when there is one. Do not leave localhost on a production
project: anything running on someone's machine could then pretend to be us.

## 2. Turn on the ways in

Same project, the authentication or sign-in methods section. Turn on **Email**,
**SMS** and **Google**, and **Apple** if you want it.

The app already asks for all four. Asking for one that is off is harmless: its
button simply never appears, which is why Google can be missing while email
works. The SDK accepts `email`, `sms`, and `oauth:` with google, apple, x,
telegram or github. That is from its own type, not from the docs.

## 3. Nothing else

No redirect URI, no Google client id of our own, no server key in the browser.
Coinbase hosts the OAuth callback. The project id is the only thing the
browser needs, and it is already in `.env.local`.

## Checking it worked

```bash
bun run dev:feed
cd ui/app && bun run dev
```

Open the app. Signed out, the corner holds one button, Sign in. Press it and
Coinbase's panel should fill the dialog with an email field and the buttons
for whatever you turned on. If it is blank, step 1 has not taken.

The browser console says which: `Failed to get project config` is the origin,
and a missing button for one provider is that provider being off.
