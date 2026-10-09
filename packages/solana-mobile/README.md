# solana-mobile

Solana Foundation's [kit-expo-privy](https://solana.com/developers/templates/kit-expo-privy) template ([source](https://github.com/solana-foundation/templates/tree/main/mobile/kit-expo-privy), commit `9e4bbfc`, MIT), copied as is. It's listed as excluded in the root `workspaces` (`!packages/solana-mobile`) on purpose: it's an npm project with its own `package-lock.json`, so its React Native dependencies never mix with the web apps'. Run everything from this folder with `npm`.

This is an [Expo](https://expo.dev) project pre-configured with [Uniwind](https://uniwind.dev/) for styling and Solana libraries.

## Technologies

- [Expo](https://expo.dev)
- [Uniwind](https://uniwind.dev/) (Tailwind CSS for React Native)
- [@solana/kit](https://github.com/solana-labs/solana-web3.js)
- [@wallet-ui/react-native-kit](https://github.com/wallet-ui/wallet-ui)

## Set up Privy

1. Log in or sign up at the [Privy dashboard](https://dashboard.privy.io).
2. On the [organization overview](https://dashboard.privy.io/organization-overview), click `New app`.
3. Enter your app name, select `Mobile app`, and click `Create app`.
4. Save the `App ID`, then click `Close`.
5. Under `User management` in the sidebar, go to `Authentication`.
6. In the `External wallets` card, enable `SVM (Solana) wallets`.
7. Go to `App settings` > `Clients`.
8. Set the app identifier to the `expo.android.package` value from `app.json`.
9. Save the `Client ID` for the default mobile app client.
10. Copy `.env.example` to `.env` and set:

```bash
EXPO_PUBLIC_PRIVY_APP_ID=your-privy-app-id
EXPO_PUBLIC_PRIVY_CLIENT_ID=your-privy-client-id
```

Do not put the Privy app secret in `.env`; this Expo app only uses public client-side Privy identifiers.

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

This steps builds the dependencies for the development client.

```bash
npm run android
```

In the output, you'll find options to open the app in an Android development build:

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)

This template requires native modules and Mobile Wallet Adapter support, so it does not support Expo Go or iOS simulator.

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Test wallet connections

Follow the [Solana Mobile development setup](https://docs.solanamobile.com/get-started/development-setup) to configure a Seeker or Android emulator for testing Mobile Wallet Adapter flows. For emulator development, install the [Mock MWA Wallet](https://github.com/solana-mobile/mock-mwa-wallet.git) and open it once before connecting from this app.

If wallet connection fails with `java.util.concurrent.CancellationException` or `-1/authorization request declined`, make sure the emulator has a PIN or password set, then restart the mock wallet:

```bash
adb shell locksettings set-pin 1234
adb shell am force-stop com.solana.mwallet
```

Open the mock wallet again so it can create and persist its seed, then try connecting from this app.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Uniwind documentation](https://uniwind.dev/): Learn how to style your app with Tailwind CSS.
- [Solana documentation](https://solana.com/docs): Learn how to build on Solana.

## Community and tablet layouts

The Trophy button opens profiles, live drawings and leaderboards. This app uses the
Solana social service (`EXPO_PUBLIC_SOCIAL_URL`), sharing API types with the web app.
Profile edits and follows require a wallet signature through Coinbase or Mobile Wallet
Adapter. The stream pauses in the background and reconnects with a fresh snapshot.

Native sheets are capped at 600 points on tablets. The app supports iPad and both
orientations; drawing geometry updates with the viewport. The community lists are
virtualized and chart overlays use bounded cached Skia paths.

The photo picker adds a native module. Rebuild the development client or release binary
before using profile photo uploads (`npm run ios` / `npm run android`). Expo Go does not
support the app's other required native wallet and graphics modules. See
[infra/README.md](../../infra/README.md) for the shared Supabase/Postgres setup. Never
put `SOCIAL_DATABASE_URL` into the Expo environment.
