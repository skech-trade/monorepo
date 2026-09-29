//! The upstream feeds: Coinbase for the price, Binance and Kraken to attest to
//! it. Each socket is held open for good:
//! reopened whenever it closes, errors or goes quiet, with a backoff that
//! resets once it opens. One long-lived public connection per venue is what
//! their market-data streams are for, well inside every venue's limits.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::extract::ws::Utf8Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{net::TcpStream, sync::broadcast, time::timeout};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_tls_with_config, tungstenite::Message};

use crate::{
    attest::{Board, Verdict, decide},
    quote::{Quoter, e8},
};

type Feed = broadcast::Sender<Utf8Bytes>;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub const MARKET: &str = "BTC-USD";
const STREAM: &str = "wss://ws-feed.exchange.coinbase.com";
const REST: &str = "https://api.exchange.coinbase.com/products";
/// BTC in USDT, and USDC in USDT to turn it into dollars: USDT is not quite one.
const BINANCE: &str = "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/usdcusdt@trade";
const KRAKEN: &str = "wss://ws.kraken.com/v2";
/// How far back a client is sent on connect: the game prices on the last five
/// minutes of one-second bars and draws the last ten.
const KEEP_MS: u64 = 600_000;
/// Coinbase pages trades a thousand at a time; ten minutes is rarely more than a few.
const PAGES: usize = 12;
const FIRST_RETRY: Duration = Duration::from_millis(500);
const LAST_RETRY: Duration = Duration::from_secs(10);

/// A trade as the engine keeps it: Coinbase's id, the exchange's time in ms, the price with 8 decimals.
#[derive(Clone, Copy)]
pub struct Trade {
    pub id: u64,
    pub t: u64,
    pub p8: u128,
}

/// The last ten minutes of trades, oldest first, for a client that has just connected.
#[derive(Clone, Default)]
pub struct History(Arc<Mutex<VecDeque<Trade>>>);

impl History {
    fn newest(&self) -> u64 {
        self.0.lock().unwrap().back().map_or(0, |x| x.id)
    }

    /// Trades newer than the newest kept, in order; anything past ten minutes falls off the front.
    fn extend(&self, trades: impl IntoIterator<Item = Trade>) {
        let mut kept = self.0.lock().unwrap();
        for x in trades {
            if kept.back().is_none_or(|last| x.id > last.id) {
                kept.push_back(x);
            }
        }
        let Some(cutoff) = kept.back().map(|x| x.t.saturating_sub(KEEP_MS)) else { return };
        while kept.front().is_some_and(|x| x.t < cutoff) {
            kept.pop_front();
        }
    }

    /// `{type:"history", trades:[[id, t, p], …]}`, unsigned: a chart needs the prices, a trade needs only the newest signature.
    pub fn frame(&self) -> Utf8Bytes {
        let kept = self.0.lock().unwrap();
        let mut out = String::with_capacity(32 + kept.len() * 36);
        out.push_str(r#"{"type":"history","trades":["#);
        for (i, x) in kept.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!("[{},{},{}]", x.id, x.t, x.p8 as f64 / 1e8));
        }
        out.push_str("]}");
        out.into()
    }
}

/// Every BTC-USD trade on Coinbase, the market the game is priced on, checked
/// against the attesters (`attest.rs`) and signed:
/// `{type:"price", id, t, p, source, coinbase, attesters, message, signature}`.
/// `p` is the price to show and the one signed, `message` the EIP-712 `Price`
/// the signature is over; both are null when no attester could check it.
/// Plus `{type:"beat", t}` with Coinbase's heartbeat each second, so a quiet
/// market is not mistaken for a dead socket.
pub async fn coinbase(feed: Feed, quoter: Arc<Quoter>, history: History, board: Board, band: f64) {
    #[derive(Deserialize)]
    struct Update<'a> {
        #[serde(rename = "type")]
        kind: &'a str,
        trade_id: Option<u64>,
        price: Option<&'a str>,
        time: Option<&'a str>,
    }

    let http = reqwest::Client::builder()
        // Coinbase turns away requests with no user agent.
        .user_agent("skech-engine")
        .timeout(Duration::from_secs(10))
        .build()
        .expect("http client");
    let subscribe = json!({ "type": "subscribe", "product_ids": [MARKET], "channels": ["matches", "heartbeat"] });
    let mut retry = FIRST_RETRY;
    let mut tally = Tally::new();
    loop {
        // Fill what was missed, ten minutes on a cold start or the gap of a reconnect, before going live.
        match backfill(&http, &history).await {
            Ok(n) if n > 0 => eprintln!("coinbase: backfilled {n} trades"),
            Ok(_) => {}
            Err(e) => eprintln!("coinbase backfill: {e}"),
        }
        // The newest trade kept, so the one Coinbase replays on subscribe is not sent twice.
        let mut last_id = history.newest();
        let run = async {
            let mut ws = open(STREAM, Some(&subscribe)).await?;
            retry = FIRST_RETRY;
            eprintln!("coinbase: connected");
            // Coinbase sends a heartbeat every second, so five quiet seconds is a dead socket.
            read(&mut ws, Duration::from_secs(5), |text| {
                let Ok(update) = serde_json::from_str::<Update>(text) else { return Ok(()) };
                let t = || update.time.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp_millis() as u64);
                if update.kind == "heartbeat" {
                    if let Some(t) = t() {
                        let _ = feed.send(json!({ "type": "beat", "t": t }).to_string().into());
                    }
                    return Ok(());
                }
                if update.kind != "match" && update.kind != "last_match" {
                    return Ok(());
                }
                let id = update.trade_id.unwrap_or(0);
                if id <= last_id {
                    return Ok(());
                }
                let cb8 = update.price.and_then(e8).filter(|p| *p > 0);
                let (Some(t), Some(cb8)) = (t(), cb8) else { return Ok(()) };
                let coinbase = cb8 as f64 / 1e8;
                let attesters = board.fresh();
                let prices: Vec<f64> = attesters.iter().map(|(_, p)| *p).collect();
                let (p8, source, signed) = match decide(coinbase, &prices, band) {
                    Verdict::Agrees => (cb8, "coinbase", true),
                    Verdict::Differs { median } => ((median * 100.0).round() as u128 * 1_000_000, "attesters", true),
                    Verdict::Alone => (cb8, "coinbase", false),
                };
                let signature = if signed { quoter.sign(MARKET, p8, t) } else { None };
                tally.add(p8, source, signature.as_deref(), coinbase, &attesters);
                last_id = id;
                history.extend([Trade { id, t, p8 }]);
                // price as a string: it is a uint256, and JavaScript numbers are not exact past 2^53.
                let message = signature.as_ref().map(|_| json!({ "market": MARKET, "price": p8.to_string(), "time": t }));
                let update = json!({
                    "type": "price", "id": id, "t": t, "p": p8 as f64 / 1e8, "source": source,
                    "coinbase": coinbase, "attesters": attesters.into_iter().map(|(name, p)| (name.to_owned(), json!(p))).collect::<serde_json::Map<_, _>>(),
                    "message": message, "signature": signature,
                });
                let _ = feed.send(update.to_string().into());
                Ok(())
            })
            .await
        };
        if let Err(e) = run.await {
            eprintln!("coinbase: {e}");
        }
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(LAST_RETRY);
    }
}

/// What is being signed, once a second, for the log: the newest price as a
/// trade would post it, who agreed, and how many trades the second had.
struct Tally {
    since: Instant,
    trades: u32,
    fallback: u32,
    unsigned: u32,
    last: String,
}

impl Tally {
    fn new() -> Self {
        Self { since: Instant::now(), trades: 0, fallback: 0, unsigned: 0, last: String::new() }
    }

    fn add(&mut self, p8: u128, source: &str, signature: Option<&str>, coinbase: f64, attesters: &[(&str, f64)]) {
        self.trades += 1;
        let price = dollars(p8);
        let apart = attesters.iter().map(|(name, p)| format!("{name} {:.3}%", ((p - coinbase) / coinbase * 100.0).abs())).collect::<Vec<_>>().join(", ");
        self.last = match signature {
            None => {
                self.unsigned += 1;
                format!("NOT signed {price}: no attester heard from")
            }
            Some(sig) => {
                let whose = if source == "coinbase" {
                    format!("coinbase, {apart}")
                } else {
                    self.fallback += 1;
                    let signed = p8 as f64 / 1e8;
                    format!("attesters' price; coinbase was {}, {:.3}% off", dollars((coinbase * 1e8).round() as u128), ((coinbase - signed) / signed * 100.0).abs())
                };
                format!("signed {price} ({whose}) {}…{}", &sig[..10], &sig[sig.len() - 8..])
            }
        };
        if self.since.elapsed() >= Duration::from_secs(1) {
            let mut extra = Vec::new();
            if self.fallback > 0 {
                extra.push(format!("{} at attesters' price", self.fallback));
            }
            if self.unsigned > 0 {
                extra.push(format!("{} unsigned", self.unsigned));
            }
            let extra = if extra.is_empty() { String::new() } else { format!(", {}", extra.join(", ")) };
            eprintln!("{} · {} trade{}{extra}", self.last, self.trades, if self.trades == 1 { "" } else { "s" });
            *self = Self::new();
        }
    }
}

/// 8345755000000 as "$83,457.55".
fn dollars(p8: u128) -> String {
    let cents = (p8 + 500_000) / 1_000_000;
    let whole = (cents / 100).to_string();
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("${grouped}.{:02}", cents % 100)
}

/// Coinbase's public trades, newest first, a page at a time going back, until
/// they reach what is already kept or ten minutes ago. Returns how many were added.
async fn backfill(http: &reqwest::Client, history: &History) -> Result<usize, String> {
    #[derive(Deserialize)]
    struct Past {
        trade_id: u64,
        price: String,
        time: String,
    }
    let known = history.newest();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
    let cutoff = now.saturating_sub(KEEP_MS);
    let mut got = Vec::new();
    let mut after = None;
    for _ in 0..PAGES {
        let url = match after {
            Some(id) => format!("{REST}/{MARKET}/trades?limit=1000&after={id}"),
            None => format!("{REST}/{MARKET}/trades?limit=1000"),
        };
        let body = http.get(url).send().await.and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
        let page: Vec<Past> = serde_json::from_str(&body.text().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let Some(oldest) = page.last() else { break };
        after = Some(oldest.trade_id);
        let mut reached = oldest.trade_id <= known;
        for x in page {
            let t = chrono::DateTime::parse_from_rfc3339(&x.time).map(|t| t.timestamp_millis() as u64);
            let (Ok(t), Some(p8)) = (t, e8(&x.price)) else { continue };
            reached |= t < cutoff;
            if x.trade_id > known && t >= cutoff {
                got.push(Trade { id: x.trade_id, t, p8 });
            }
        }
        if reached {
            break;
        }
    }
    got.reverse();
    let n = got.len();
    history.extend(got);
    Ok(n)
}

/// Binance's BTC/USDT trades, in dollars through its own USDC/USDT, onto the board.
pub async fn binance(board: Board) {
    #[derive(Deserialize)]
    struct Wrapped<'a> {
        stream: &'a str,
        #[serde(borrow)]
        data: Trade<'a>,
    }
    #[derive(Deserialize)]
    struct Trade<'a> {
        p: &'a str,
    }
    // USDT per USDC. Until the first one trades there is no dollar price to post.
    let mut usdc: Option<f64> = None;
    hold("binance", BINANCE, None, Duration::from_secs(10), |text| {
        let Ok(m) = serde_json::from_str::<Wrapped>(text) else { return Ok(()) };
        let Ok(p) = m.data.p.parse::<f64>() else { return Ok(()) };
        match m.stream {
            "usdcusdt@trade" => usdc = Some(p),
            "btcusdt@trade" => {
                if let Some(usdc) = usdc {
                    board.set("binance", p / usdc);
                }
            }
            _ => {}
        }
        Ok(())
    })
    .await
}

/// Kraken's BTC/USD trades onto the board.
pub async fn kraken(board: Board) {
    #[derive(Deserialize)]
    struct Channel<'a> {
        channel: Option<&'a str>,
    }
    #[derive(Deserialize)]
    struct Trades {
        data: Vec<Trade>,
    }
    #[derive(Deserialize)]
    struct Trade {
        price: f64,
    }
    let subscribe = json!({ "method": "subscribe", "params": { "channel": "trade", "symbol": [MARKET.replace('-', "/")] } });
    // Kraken sends a heartbeat every second.
    hold("kraken", KRAKEN, Some(subscribe), Duration::from_secs(10), |text| {
        if serde_json::from_str::<Channel>(text).ok().and_then(|c| c.channel) != Some("trade") {
            return Ok(());
        }
        if let Some(last) = serde_json::from_str::<Trades>(text).ok().and_then(|t| t.data.last().map(|x| x.price)) {
            board.set("kraken", last);
        }
        Ok(())
    })
    .await
}

/// One upstream socket, held open for good. A failure is logged once, not on
/// every retry, until it changes or the socket comes back.
async fn hold(name: &str, url: &str, subscribe: Option<Value>, silent: Duration, mut on_text: impl FnMut(&str) -> Result<(), String>) {
    let mut retry = FIRST_RETRY;
    let mut failing: Option<String> = None;
    loop {
        let run = async {
            let mut ws = open(url, subscribe.as_ref()).await?;
            retry = FIRST_RETRY;
            eprintln!("{name}: {}", if failing.take().is_some() { "back" } else { "connected" });
            read(&mut ws, silent, &mut on_text).await
        };
        if let Err(e) = run.await {
            if failing.as_deref() != Some(e.as_str()) {
                eprintln!("{name}: {e} (retrying, quietly)");
                failing = Some(e);
            }
        }
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(LAST_RETRY);
    }
}

async fn open(url: &str, subscribe: Option<&Value>) -> Result<Socket, String> {
    // `true`: no Nagle, each frame goes out as soon as it is written.
    let (mut ws, _) = connect_async_tls_with_config(url, None, true, None).await.map_err(|e| e.to_string())?;
    if let Some(subscribe) = subscribe {
        ws.send(Message::Text(subscribe.to_string().into())).await.map_err(|e| e.to_string())?;
    }
    Ok(ws)
}

/// Hand each text frame to `on_text` until the socket closes, errors, goes quiet for `silent`, or `on_text` gives up.
async fn read(ws: &mut Socket, silent: Duration, mut on_text: impl FnMut(&str) -> Result<(), String>) -> Result<(), String> {
    loop {
        match timeout(silent, ws.next()).await {
            Err(_) => return Err(format!("nothing for {}s", silent.as_secs())),
            Ok(None) | Ok(Some(Ok(Message::Close(_)))) => return Err("closed".into()),
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(Some(Ok(Message::Text(text)))) => on_text(&text)?,
            // Pings are answered by tungstenite on the next read.
            Ok(Some(Ok(_))) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn dollars_reads_like_money() {
        assert_eq!(super::dollars(8_345_755_000_000), "$83,457.55");
        assert_eq!(super::dollars(99_999_999), "$1.00");
        assert_eq!(super::dollars(12_345_678_912_345_678), "$123,456,789.12");
    }
}
