//! skech engine: one WebSocket per client app.
//!
//! Down the socket, on connect: who signs and the EIP-712 domain and types
//! they sign under, then the last ten minutes of trades. After that, every
//! BTC-USD trade as it lands, each checked against Binance and Kraken and
//! signed, and Coinbase's heartbeat each second. Upstream it holds a socket to
//! each venue, and fans what it signs out to every client.

mod attest;
mod feeds;
mod quote;

use std::{env, net::SocketAddr, sync::Arc};

use alloy_primitives::Address;
use alloy_signer_local::PrivateKeySigner;
use axum::{
    Router,
    extract::{
        State,
        ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
    },
    response::Response,
    routing::get,
    serve::ListenerExt,
};
use serde_json::json;
use tokio::sync::broadcast;

use crate::{attest::Board, feeds::History, quote::Quoter};

/// Updates a client can fall behind by before it skips ahead to the newest.
const BACKLOG: usize = 1024;

#[derive(Clone)]
struct App {
    /// The first message every client gets: who signs, and the EIP-712 domain and types to check against.
    hello: Utf8Bytes,
    history: History,
    /// Each update, serialized once, shared by every client.
    feed: broadcast::Sender<Utf8Bytes>,
}

fn main() {
    // The monorepo's one `.env.local`, found by walking up from here. Anything already in the environment wins.
    let _ = dotenvy::from_filename(".env.local");
    // One TLS backend for both the WebSocket and the HTTP client: ring, the only one compiled in.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let wallet = match var("ENGINE_PRIVATE_KEY") {
        Some(key) => key.parse::<PrivateKeySigner>().expect("ENGINE_PRIVATE_KEY is not a hex private key"),
        None => {
            eprintln!("ENGINE_PRIVATE_KEY not set: signing with a throwaway wallet");
            PrivateKeySigner::random()
        }
    };
    // Signatures are bound to one chain and one contract. SKECH_NETWORK picks the chain, the deploy's file names the
    // game on it. ENGINE_CHAIN_ID and ENGINE_VERIFYING_CONTRACT (or SKECH_GAME, as the relayer and app read) still win.
    let chain_id = chain_id();
    let contract = var("ENGINE_VERIFYING_CONTRACT")
        .or_else(|| var("SKECH_GAME"))
        .map(|a| a.parse::<Address>().expect("ENGINE_VERIFYING_CONTRACT / SKECH_GAME is not an address"))
        .or_else(|| deployed_game(chain_id))
        .unwrap_or_else(|| {
            eprintln!("no game deployed on chain {chain_id}: signing for the zero address until bun run deploy:contracts puts one there");
            Address::ZERO
        });
    let quoter = Arc::new(Quoter::new(wallet, chain_id, contract));
    eprintln!("signing as {} for chain {chain_id}, contract {contract}", quoter.address());

    // How far the attesters' median may be from Coinbase before it is signed instead, in basis points.
    let band_bps: f64 = var("ENGINE_BAND_BPS").map(|b| b.parse().expect("ENGINE_BAND_BPS is not a number")).unwrap_or(1.0);
    let band = band_bps / 10_000.0;
    eprintln!("attesting with binance and kraken, band {}%", band * 100.0);
    let port = var("ENGINE_PORT").and_then(|p| p.parse().ok()).unwrap_or(3102);

    // Up once the config is read: a bad one panics on every restart, into the journal, not the Sentry plan.
    // Before the runtime, so each worker thread starts with the client bound.
    let _sentry = sentry_init(chain_id, quoter.address());
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(serve(quoter, band, port));
}

async fn serve(quoter: Arc<Quoter>, band: f64, port: u16) {
    let (feed, _) = broadcast::channel(BACKLOG);
    let history = History::default();
    let app = App {
        hello: json!({
            "type": "hello", "signer": quoter.address().to_checksum(None), "typedData": quoter.typed_data(),
            "attest": { "by": ["binance", "kraken"], "band": band },
        })
            .to_string()
            .into(),
        history: history.clone(),
        feed: feed.clone(),
    };
    let board = Board::default();
    tokio::spawn(feeds::binance(board.clone()));
    tokio::spawn(feeds::kraken(board.clone()));
    tokio::spawn(feeds::coinbase(feed, quoter, history, board, band));

    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(upgrade))
        .with_state(app);

    let listener = match tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("can't listen on port {port}: {e}. Is another engine running? `lsof -iTCP:{port} -sTCP:LISTEN` says who has it.");
            std::process::exit(1);
        }
    }
    // Small frames go out now, not batched up by Nagle.
    .tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    eprintln!("listening on ws://localhost:{port}/ws");
    axum::serve(listener, router).await.expect("server stopped");
}

/// Sentry, for what takes the engine down: a panic is sent, stack and all, before `panic = "abort"` ends the
/// process. Off unless ENGINE_SENTRY_DSN is set, and off on a laptop (no SENTRY_ENVIRONMENT; the box's unit sets
/// production) unless ENGINE_SENTRY_DEV=1, so `bun run dev:engine` never spends the plan.
fn sentry_init(chain_id: u64, signer: Address) -> Option<sentry::ClientInitGuard> {
    let dsn = var("ENGINE_SENTRY_DSN")?;
    let environment = var("SENTRY_ENVIRONMENT").unwrap_or_else(|| "development".into());
    if environment == "development" && var("ENGINE_SENTRY_DEV").is_none() {
        return None;
    }
    let mut options = sentry::ClientOptions::default();
    // The commit infra/deploy.sh built, else engine@<version>.
    options.release = option_env!("SKECH_RELEASE").map(Into::into).or_else(|| sentry::release_name!());
    options.environment = Some(environment.into());
    let guard = sentry::init((dsn, options));
    sentry::configure_scope(|scope| {
        scope.set_tag("chain", chain_id);
        scope.set_tag("signer", signer);
    });
    Some(guard)
}

/// A variable that is set to something: `KEY=` left blank in `.env.local` counts as unset.
fn var(name: &str) -> Option<String> {
    env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

async fn upgrade(ws: WebSocketUpgrade, State(app): State<App>) -> Response {
    ws.on_upgrade(move |socket| client(socket, app))
}

/// Push-only: the engine signs what it saw, never what a client asks it to.
async fn client(mut socket: WebSocket, app: App) {
    // Subscribed before the history is read, so no trade falls between the two; one in both is dropped by id.
    let mut feed = app.feed.subscribe();
    for frame in [app.hello.clone(), app.history.frame()] {
        if socket.send(Message::Text(frame)).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            update = feed.recv() => match update {
                Ok(text) => if socket.send(Message::Text(text)).await.is_err() { return },
                // Too slow to keep up: drop what it missed, the next price supersedes it.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            // Read only to notice the client going away; pings are answered by axum.
            msg = socket.recv() => if matches!(msg, Some(Ok(Message::Close(_))) | Some(Err(_)) | None) { return },
        }
    }
}

/// The chain from SKECH_NETWORK (blank is testnet), or ENGINE_CHAIN_ID for anvil. The other network's id is refused:
/// a leftover testnet id under mainnet would sign prices no mainnet game accepts.
fn chain_id() -> u64 {
    let network = var("SKECH_NETWORK").unwrap_or_else(|| "testnet".into()).to_lowercase();
    let own = match network.as_str() {
        "testnet" => 10143,
        "mainnet" => 143,
        other => panic!("SKECH_NETWORK is \"{other}\": it must be testnet or mainnet"),
    };
    match var("ENGINE_CHAIN_ID").map(|id| id.parse::<u64>().expect("ENGINE_CHAIN_ID is not a number")) {
        None => own,
        Some(id) if id == own || (id != 10143 && id != 143) => id,
        Some(id) => panic!("ENGINE_CHAIN_ID is {id} but SKECH_NETWORK is {network}: remove ENGINE_CHAIN_ID, the network picks the chain"),
    }
}

/// The game in packages/evm-contracts/deployments/<chain>.json, looked for from here up to the repo root.
fn deployed_game(chain_id: u64) -> Option<Address> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let file = dir.join("packages/evm-contracts/deployments").join(format!("{chain_id}.json"));
        if let Ok(text) = std::fs::read_to_string(&file) {
            let json: serde_json::Value = serde_json::from_str(&text).ok()?;
            return json.get("game")?.as_str()?.parse().ok();
        }
        if !dir.pop() {
            return None;
        }
    }
}
