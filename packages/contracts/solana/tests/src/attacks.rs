//! Every way found to cheat the game, each refused: the attack as it was first shown to work, and what stops it.

use anchor_lang::prelude::Pubkey;
use anchor_lang::AnchorSerialize;
use solana_signer::Signer;

use crate::harness::*;
use skech::error::SkechError;
use skech::state::BET_SEED;

const S: i64 = 1_790_000_000;
const AT: (u8, u32, u16, u32) = (1, 415_000, 5, 50_000);
const HALF: u32 = 500_000_000;

fn open_at() -> i64 {
    (S + 1) * 1000
}

/// A bet's address at every bump but the canonical one: about half of them are valid PDAs.
fn other_bet_addresses(wallet: &Pubkey, drawing: u64, index: u32) -> Vec<Pubkey> {
    let (_, canonical) = bet_pda(wallet, drawing, index);
    let (d, i) = (drawing.to_le_bytes(), index.to_le_bytes());
    (0..canonical).rev().filter_map(|bump| Pubkey::create_program_address(&[BET_SEED, wallet.as_ref(), &d, &i, &[bump]], &skech::ID).ok()).collect()
}

#[test]
fn a_piece_is_placed_once_not_again_at_another_bump() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, 1, 0, open_at(), &[AT]);
    let quote = g.quote(&piece, HALF);
    g.place(&p, &piece, &quote).expect("placed");
    let balance = g.player_state(&p).balance;
    let others = other_bet_addresses(&p.wallet.pubkey(), 1, 0);
    assert!(others.len() >= 3);
    // The same signed piece, sent again with its bet at another valid address: refused every time.
    for bet in others.into_iter().take(3) {
        let bytes = piece.try_to_vec().unwrap();
        let ed = Game::ed25519_ix(&p.session, &bytes, 1, 8, bytes.len() as u16);
        let mut place = g.place_ix(&piece, &quote);
        place.accounts[7].pubkey = bet;
        assert_eq!(custom_error(&g.send(&[ed, place], &[])), Some(code(SkechError::Mismatch)));
    }
    assert_eq!(g.player_state(&p).balance, balance, "charged once");
}
