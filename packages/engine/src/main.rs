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

#[tokio::main]
async fn main() {
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
    // Signatures are bound to one chain and one contract. Until there is a contract: a local anvil chain and no address.
    let chain_id = var("ENGINE_CHAIN_ID").map(|id| id.parse().expect("ENGINE_CHAIN_ID is not a number")).unwrap_or(31337);
    let contract = var("ENGINE_VERIFYING_CONTRACT")
        .map(|a| a.parse::<Address>().expect("ENGINE_VERIFYING_CONTRACT is not an address"))
        .unwrap_or(Address::ZERO);
    let quoter = Arc::new(Quoter::new(wallet, chain_id, contract));
    eprintln!("signing as {} for chain {chain_id}, contract {contract}", quoter.address());

    // How far the attesters' median may be from Coinbase before it is signed instead, in basis points.
    let band_bps: f64 = var("ENGINE_BAND_BPS").map(|b| b.parse().expect("ENGINE_BAND_BPS is not a number")).unwrap_or(1.0);
    let band = band_bps / 10_000.0;
    eprintln!("attesting with binance and kraken, band {}%", band * 100.0);

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

    let port = var("ENGINE_PORT").and_then(|p| p.parse().ok()).unwrap_or(3102);
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
