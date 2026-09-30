/** Where the app reaches the engine and the Solana relayer, and the Coinbase project it signs in with. */
export const ENGINE_URL = process.env.EXPO_PUBLIC_ENGINE_URL || "wss://api.skech.trade/engine/ws";
export const RELAYER_URL = process.env.EXPO_PUBLIC_RELAYER_URL || "wss://api.skech.trade/solana/ws";
export const CDP_PROJECT_ID = process.env.EXPO_PUBLIC_CDP_PROJECT_ID ?? "";
/** Whether this build can sign anyone in at all: without a project id the app plays for practice money. */
export const hasAuth = CDP_PROJECT_ID !== "";
