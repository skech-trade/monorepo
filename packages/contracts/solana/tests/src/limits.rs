//! What a transaction can hold, and what each instruction costs in compute units: the relayer sets its compute
//! limits from `snapshots/compute.json`, which `SNAPSHOT=1 cargo test` writes.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::AnchorSerialize;
use solana_message::{v0, AddressLookupTableAccount, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

use crate::harness::*;

const S: i64 = 1_790_000_000;
const COMPUTE_BUDGET: Pubkey = anchor_lang::prelude::pubkey!("ComputeBudget111111111111111111111111111111");

fn budget(limit: u32, micro_lamports: u64) -> [Instruction; 2] {
    let mut a = vec![2u8];
    a.extend_from_slice(&limit.to_le_bytes());
    let mut b = vec![3u8];
    b.extend_from_slice(&micro_lamports.to_le_bytes());
    [Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: a }, Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: b }]
}

/// 32 bands, each a different second and price.
fn widest(n: usize) -> Vec<(u8, u32, u16, u32)> {
    (0..n).map(|i| ((i % 30 + 1) as u8, 414_000 + 40 * i as u32, 5, 10_000)).collect()
}

#[test]
fn the_widest_piece_fits_one_transaction_with_a_lookup_table() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, u64::MAX, u32::MAX, (S + 1) * 1000, &widest(skech::state::MAX_SECTIONS));
    let quote = g.quote(&piece, 500_000_000);
    let bytes = piece.try_to_vec().unwrap();
    let [limit, price] = budget(200_000, 50_000);
    let ed = Game::ed25519_ix(&p.session, &bytes, 3, 8, bytes.len() as u16);
    let place = g.place_ix(&piece, &quote);
    // What every placement shares goes in the table; the player, the bet and the programs cannot.
    let table = AddressLookupTableAccount {
        key: Pubkey::new_unique(),
        addresses: vec![game_pda(), market_pda(0), bars_pda(0), pool_pda(), anchor_lang::solana_program::sysvar::instructions::ID, anchor_lang::system_program::ID],
    };
    let msg = v0::Message::try_compile(&g.relayer.pubkey(), &[limit, price, ed, place], &[table], g.svm.latest_blockhash()).unwrap();
    let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &[&g.relayer]).unwrap();
    let size = bincode::serialize(&tx).unwrap().len();
    println!("a placement of {} bands: {size} bytes", skech::state::MAX_SECTIONS);
    assert!(size <= 1232, "{size} bytes: over Solana's 1232");
}

/// A drawing, from `from` on, whose bet's canonical bump is `bump`: `place` searches down from 255 for it, and every
/// bump it tries costs compute.
fn drawing_at_bump(wallet: &Pubkey, from: u64, bump: impl Fn(u8) -> bool) -> u64 {
    (from..).find(|&d| bump(bet_pda(wallet, d, 0).1)).unwrap()
}

#[test]
fn compute_units() {
    let mut out = serde_json::Map::new();
    let mut g = Game::new();
    let mut players = vec![];
    for n in [1usize, 8, 16, 32] {
        let p = g.player(100 * E6, 50 * E6);
        // Measured at bump 255, where the search ends at once.
        let drawing = drawing_at_bump(&p.wallet.pubkey(), n as u64, |b| b == 255);
        let piece = g.piece(&p, drawing, 0, (S + 1) * 1000, &widest(n));
        let quote = g.quote(&piece, 500_000_000);
        let r = g.place(&p, &piece, &quote).expect("placed");
        println!("place, {n} bands: {} CU", r.compute_units_consumed);
        out.insert(format!("place_{n}"), r.compute_units_consumed.into());
        players.push((bet_pda(&p.wallet.pubkey(), drawing, 0).0, p.wallet.pubkey()));
    }
    // What each bump below 255 adds: the relayer knows a bet's bump, and budgets for it.
    let p = g.player(100 * E6, 50 * E6);
    let drawing = drawing_at_bump(&p.wallet.pubkey(), 1_000, |b| b <= 251);
    let bump = bet_pda(&p.wallet.pubkey(), drawing, 0).1;
    let piece = g.piece(&p, drawing, 0, (S + 1) * 1000, &widest(1));
    let r = g.place(&p, &piece, &g.quote(&piece, 500_000_000)).expect("placed");
    let per_bump = (r.compute_units_consumed - out["place_1"].as_u64().unwrap()).div_ceil(255 - bump as u64);
    println!("place, each bump below 255: {per_bump} CU");
    out.insert("place_per_bump".into(), per_bump.into());
    // Every bet has a band in second 1: settle all four on it.
    g.set_time(S + 3);
    let r = g.post_and_settle((S + 2) * 1000, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &players).expect("settled");
    println!("post a bar and settle 4 bets (1, 8, 16, 32 bands): {} CU", r.compute_units_consumed);
    out.insert("post_and_settle_4_mixed".into(), r.compute_units_consumed.into());
    let r = g.post_and_settle((S + 2) * 1000 + 1000, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &[]).expect("posted");
    println!("post a bar alone: {} CU", r.compute_units_consumed);
    out.insert("post_bar".into(), r.compute_units_consumed.into());
    settle_costs(&mut out);
    let _ = AccountMeta::new(Pubkey::default(), false);
    if std::env::var("SNAPSHOT").is_ok() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../snapshots/compute.json");
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    }
}

/// What settling costs, part by part, for the relayer's budget (`packages/relayer/src/solana/compute.ts`): the
/// instruction with no bets, each bet, each band a bet has (every one is read), and each band decided (the dearer of a
/// hit and a miss). A settlement is budgeted as their sum, so a second full of bands is budgeted for its bands and not
/// only for its bets.
fn settle_costs(out: &mut serde_json::Map<String, serde_json::Value>) {
    let mut g = Game::new();
    // A loser who fills the pool, so the hits below are paid.
    let funder = g.player(1_000 * E6, 1_000 * E6);
    let mut at = S + 10;
    g.set_time(at);
    let mut fund = g.piece(&funder, 1, 0, (at + 1) * 1000, &[(1, 300_000, 5, 100_000_000)]);
    fund.per_dot = 100_000_000;
    let quote = g.quote(&fund, 500_000_000);
    g.place(&funder, &fund, &quote).expect("placed");
    g.set_time(at + 3);
    g.post_and_settle((at + 2) * 1000, 83_000 * E8, 83_000 * E8, 83_000 * E8, 83_000 * E8, &[(bet_pda(&funder.wallet.pubkey(), 1, 0).0, funder.wallet.pubkey())]).expect("settled");
    let p = g.player(100 * E6, 100 * E6);
    let mut drawing = 10;
    // Settle one piece of `bands` (second, lo) at its second 1, on a bar at 83,000: what it costs, the bar included.
    let mut one = |g: &mut Game, bands: Vec<(u8, u32)>| -> u64 {
        at += 40;
        drawing += 1;
        g.set_time(at);
        let sections: Vec<(u8, u32, u16, u32)> = bands.iter().map(|&(s, lo)| (s, lo, 5, 10_000)).collect();
        let piece = g.piece(&p, drawing, 0, (at + 1) * 1000, &sections);
        g.place(&p, &piece, &g.quote(&piece, 500_000_000)).expect("placed");
        g.set_time(at + 3);
        let [limit, _] = budget(1_400_000, 0);
        let ix = g.post_and_settle_ix((at + 2) * 1000, 83_000 * E8, 83_000 * E8, 83_000 * E8, 83_000 * E8, &[(bet_pda(&p.wallet.pubkey(), drawing, 0).0, p.wallet.pubkey())]);
        g.send(&[limit, ix], &[]).expect("settled").compute_units_consumed
    };
    let one_band = one(&mut g, vec![(1, 300_000)]);
    let one_of_32 = one(&mut g, (0..32).map(|i| (if i == 0 { 1 } else { 2 + (i % 29) as u8 }, 300_000 + 40 * i as u32)).collect());
    let all_miss = one(&mut g, (0..32).map(|i| (1, 300_000 + 40 * i as u32)).collect());
    let all_hit = one(&mut g, (0..32).map(|_| (1, 415_000)).collect());
    at += 40;
    g.set_time(at);
    let [limit, _] = budget(1_400_000, 0);
    let post_bar = g.send(&[limit.clone(), g.post_and_settle_ix(at * 1000, 83_000 * E8, 83_000 * E8, 83_000 * E8, 83_000 * E8, &[])], &[]).expect("posted").compute_units_consumed;
    let settle = g.ix(skech::accounts::Settle { game: game_pda(), bars: bars_pda(0), pool: pool_pda(), rent_receiver: g.relayer.pubkey() }, skech::instruction::Settle { market: 0 });
    let base = g.send(&[limit, settle], &[]).expect("settled nothing").compute_units_consumed;
    let section = (one_of_32 - one_band).div_ceil(31);
    let decided = (all_miss.max(all_hit) - one_of_32).div_ceil(31);
    let bet = one_band.saturating_sub(post_bar + section + decided);
    println!("settle: {base} CU with no bets; each bet {bet}, each of its bands {section}, each decided {decided} (32 missed {all_miss}, 32 hit {all_hit})");
    for (k, v) in [("settle_base", base), ("settle_bet", bet), ("settle_section", section), ("settle_decided", decided)] {
        out.insert(k.into(), v.into());
    }
}

/// The relayer's budget for one settlement (`compute.ts` `settleCompute`), from `snapshots/compute.json`: the bar or
/// not, and each bet's (bands, bands decided).
fn relayer_budget(bar: bool, bets: &[(u64, u64)]) -> u32 {
    let snap: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../snapshots/compute.json")).unwrap()).unwrap();
    let k = |key: &str| snap[key].as_f64().unwrap_or(0.0);
    let mut cu = if bar { k("post_bar") } else { k("settle_base") };
    for &(sections, decided) in bets {
        cu += k("settle_bet") + k("settle_section") * sections as f64 + k("settle_decided") * decided as f64;
    }
    ((cu * 1.25).ceil() as u32 + 5_000).min(1_400_000)
}

/// The audit's liveness finding, turned round: one wallet's nine pieces of 32 one-micro-USDC bands in one second, every
/// band missing, settle at the budget the relayer now asks for, by their bands; and twelve players' full pieces too.
#[test]
fn nine_full_pieces_in_one_second_settle_within_the_budget() {
    let mut g = Game::new();
    let s0 = S + 5;
    g.set_time(s0);
    let p = g.player(10 * E6, 10 * E6);
    let mut bets = vec![];
    for d in 0..9u64 {
        let sections: Vec<(u8, u32, u16, u32)> = (0..32).map(|i| (1u8, 300_000 + 40 * i as u32, 5, 1)).collect();
        let piece = g.piece(&p, d + 1, 0, (s0 + 1) * 1000, &sections);
        g.place(&p, &piece, &g.quote(&piece, 300_000_000)).unwrap();
        bets.push((bet_pda(&p.wallet.pubkey(), d + 1, 0).0, p.wallet.pubkey()));
    }
    g.set_time(s0 + 3);
    let ask = relayer_budget(true, &[(32, 32); 9]);
    let [limit, _] = budget(ask, 0);
    let r = g.send(&[limit, g.post_and_settle_ix((s0 + 2) * 1000, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &bets)], &[]);
    let used = r.as_ref().map(|m| m.compute_units_consumed).unwrap_or_else(|f| panic!("over its budget {ask}: {:?}", f.meta.logs.last()));
    println!("one wallet, 9 x 32 dust bands in one second: {used} CU of a budget of {ask}");

    // Twelve players, the most a settlement holds, each a full piece in one second.
    let mut g = Game::new();
    g.set_time(s0);
    let mut bets = vec![];
    for _ in 0..12 {
        let p = g.player(10 * E6, 10 * E6);
        let sections: Vec<(u8, u32, u16, u32)> = (0..32).map(|i| (1u8, 300_000 + 40 * i as u32, 5, 10_000)).collect();
        let piece = g.piece(&p, 1, 0, (s0 + 1) * 1000, &sections);
        g.place(&p, &piece, &g.quote(&piece, 300_000_000)).unwrap();
        bets.push((bet_pda(&p.wallet.pubkey(), 1, 0).0, p.wallet.pubkey()));
    }
    g.set_time(s0 + 3);
    let ask = relayer_budget(true, &[(32, 32); 12]);
    let [limit, _] = budget(ask, 0);
    let r = g.send(&[limit, g.post_and_settle_ix((s0 + 2) * 1000, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &bets)], &[]);
    let used = r.as_ref().map(|m| m.compute_units_consumed).unwrap_or_else(|f| panic!("over its budget {ask}: {:?}", f.meta.logs.last()));
    println!("twelve players, 12 x 32 missed bands in one second: {used} CU of a budget of {ask}");
}

/// The accounts' sizes, now worked out rather than written out: the same bytes as the accounts already on chain.
#[test]
fn account_sizes_are_what_is_on_chain() {
    assert_eq!(skech::state::Bars::SPACE, 9_624);
    // A bet's fixed part, and each section.
    assert_eq!(skech::state::Bet::FIXED, 130);
    assert_eq!(skech::state::Bet::space(32), 130 + 32 * 27);
}

/// A piece's bytes and a domain, for `sdk.test.ts` to check the TypeScript encodes them the same.
#[test]
fn vectors_for_the_typescript() {
    let p = skech::piece::PieceMessage {
        domain: skech::instructions::domain_for(&skech::ID, "devnet"),
        player: anchor_lang::prelude::pubkey!("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
        drawing: 1_790_000_123_456,
        index: 7,
        market: 0,
        difficulty: 40,
        open_at: 1_790_000_001_000,
        per_dot: 100_000,
        unit: 20_000_000,
        price_seen: 8_300_012_345_678,
        price_time: 1_790_000_000_450,
        stroke_hash: [0xab; 32],
        sections: vec![skech::piece::SectionArg { second: 1, lo: 415_000, width: 5, stake: 50_000 }, skech::piece::SectionArg { second: 30, lo: 414_990, width: 12, stake: 4_294_967_295 }],
    };
    let json = serde_json::json!({ "program": skech::ID.to_string(), "domain": p.domain.to_vec(), "piece": p.try_to_vec().unwrap() });
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/piece.json");
    if std::env::var("SNAPSHOT").is_ok() {
        std::fs::write(path, json.to_string() + "\n").unwrap();
    }
    let committed: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(committed, json, "vectors/piece.json is out of date: SNAPSHOT=1 cargo test -p tests");
}
