//! What the game keeps on chain. Every account a placement writes is the player's own (their `Player` and the
//! new `Bet`) plus the `Pool`, so placements by different players only meet on the pool. `Game` and `Market`
//! are read-only to players; the `Bars` ring is written once a second by the oracle.

use anchor_lang::prelude::*;

pub const GAME_SEED: &[u8] = b"game";
pub const POOL_SEED: &[u8] = b"pool";
pub const MARKET_SEED: &[u8] = b"market";
pub const BARS_SEED: &[u8] = b"bars";
pub const PLAYER_SEED: &[u8] = b"player";
pub const BET_SEED: &[u8] = b"bet";

/// Seconds ahead a band may be.
pub const HORIZON: u8 = 30;
/// Sections in one piece, at most: a piece with 32 fills a transaction (1232 bytes) with a lookup table.
pub const MAX_SECTIONS: usize = 32;
/// Seconds of price the ring keeps: the horizon, the grace and plenty of room for a relayer that falls behind.
pub const BAR_RING: usize = 240;
/// An IOU share's index at the start, x1e18: one share was worth one millionth of a USDC.
pub const INDEX_ONE: u128 = 1_000_000_000_000_000_000;
pub const BPS: u64 = 10_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub struct Config {
    /// Of every stake, as it is placed, to the house.
    pub fee_bps: u16,
    /// Of every hit's profit, to the house.
    pub profit_fee_bps: u16,
    /// Of an IOU's growth, to whoever redeems it for someone else.
    pub sweep_bps: u16,
    /// How late after its opening second the oracle may have received a piece, ms.
    pub late_ms: u32,
    /// How far from its opening second a placement may land, and how early a second may be posted, ms.
    pub place_grace_ms: u32,
    /// How old the price a player saw may be when the oracle received the piece, ms.
    pub max_price_age_ms: u32,
    /// What a dot may cost, USDC e6.
    pub min_per_dot: u64,
    pub max_per_dot: u64,
    /// The most one piece may stake, USDC e6.
    pub max_piece_stake: u64,
    /// The least a partial IOU redemption may be worth, USDC e6.
    pub min_redeem: u64,
    /// How far ahead a session may be set to expire, seconds.
    pub max_session_secs: i64,
}

impl Config {
    pub const DEFAULT: Config = Config {
        fee_bps: 200,
        profit_fee_bps: 1000,
        sweep_bps: 1000,
        late_ms: 200,
        place_grace_ms: 3000,
        max_price_age_ms: 15_000,
        min_per_dot: 10_000,       // 1 cent
        max_per_dot: 10_000_000,   // $10: a section's stake fits in a u32
        max_piece_stake: 1_000_000_000, // $1,000
        min_redeem: 10_000,
        max_session_secs: 30 * 86_400,
    };
}

/// The game: who runs it, what it trades in, and its terms. Its PDA owns the vault.
#[account]
#[derive(InitSpace)]
pub struct Game {
    pub admin: Pubkey,
    /// Set by `propose_admin`, takes over on `accept_admin`: an admin is never handed to a key that cannot sign.
    pub pending_admin: Pubkey,
    /// Signs every placement (its quote) and every bar.
    pub oracle: Pubkey,
    pub usdc_mint: Pubkey,
    /// The token program the mint is under: SPL Token for USDC, Token-2022 allowed.
    pub token_program: Pubkey,
    /// Every player's USDC, the pool and the fees: the game PDA's associated token account.
    pub vault: Pubkey,
    /// Where collected fees go: a token account of the treasury (a multisig on mainnet).
    pub treasury: Pubkey,
    /// What every piece a session key signs starts with: sha256("skech/v1" || program id || cluster), so a
    /// signature for devnet never places on mainnet, or on another deployment.
    pub domain: [u8; 32],
    pub paused: bool,
    pub config: Config,
    pub bump: u8,
}

/// The money that is not anyone's balance: what backs live stakes and pays hits, and the house's fees.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// USDC backing live stakes and paying hits, e6.
    pub pool: u64,
    /// Fees taken and not yet collected, e6.
    pub fees: u64,
    /// An IOU share's value at `iou_time_at`, x1e18, rising by `iou_rate` every second.
    pub iou_index_at: u128,
    pub iou_rate: u64,
    pub iou_time_at: i64,
    /// Every share outstanding, the house's included.
    pub iou_shares: u128,
    /// What the house is owed in fees the pool could not pay at once.
    pub house_shares: u128,
    pub house_basis: u64,
    pub bump: u8,
}

impl Pool {
    pub fn index(&self, now: i64) -> u128 {
        let dt = (now - self.iou_time_at).max(0) as u128;
        self.iou_index_at + self.iou_rate as u128 * dt
    }
    /// What `shares` are worth now, e6, rounded down.
    pub fn value_of(&self, shares: u128, now: i64) -> u64 {
        (shares * self.index(now) / INDEX_ONE) as u64
    }
    /// How many shares `value` is worth now, rounded up: an IOU is never worth less than what was owed.
    pub fn shares_for(&self, value: u64, now: i64) -> u128 {
        let index = self.index(now);
        (value as u128 * INDEX_ONE).div_ceil(index)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: u8,
    pub active: bool,
    /// 50 to 100: how hard the game is here. Pieces placed from now on pay by it.
    pub difficulty: u8,
    /// What the engine calls it: "BTC-USD".
    #[max_len(16)]
    pub name: String,
    pub bump: u8,
}

/// One second of the price, 8 decimals: from the second before's close to this one's high, low and close.
#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct Bar {
    /// The second it is, ms since the epoch on the exchange's clock; 0 is an empty slot.
    pub second: i64,
    pub prev_close: u64,
    pub high: u64,
    pub low: u64,
    pub close: u64,
}

/// The last `BAR_RING` seconds of a market's price, one slot per second. A slot is reused when its second comes
/// round again; settling only ever looks thirty seconds back, and a bet lives only until its last second is here.
#[account(zero_copy)]
pub struct Bars {
    pub market: u8,
    pub _pad: [u8; 7],
    /// The latest second posted, ms.
    pub last: i64,
    pub ring: [Bar; BAR_RING],
}

impl Bars {
    pub const SPACE: usize = 8 + 1 + 7 + 8 + BAR_RING * 40;

    fn slot(second: i64) -> usize {
        (second.div_euclid(1000)).rem_euclid(BAR_RING as i64) as usize
    }
    /// The bar for `second`, if it is posted and still in the ring.
    pub fn at(&self, second: i64) -> Option<&Bar> {
        let b = &self.ring[Self::slot(second)];
        (b.second == second && second != 0).then_some(b)
    }
    pub fn put(&mut self, bar: Bar) {
        let s = Self::slot(bar.second);
        self.ring[s] = bar;
        if bar.second > self.last {
            self.last = bar.second;
        }
    }
}

/// A player's session key: an Ed25519 key their app keeps, which may place pieces for them, up to an allowance,
/// until it expires. It can never withdraw.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct Session {
    pub key: Pubkey,
    /// Unix seconds, by the chain's clock.
    pub valid_until: i64,
    /// USDC e6 the session may still stake.
    pub allowance: u64,
}

/// A player: their balance in the game, their session and what they are owed. Keyed by their wallet.
#[account]
#[derive(InitSpace)]
pub struct Player {
    pub authority: Pubkey,
    /// USDC e6, theirs to play with or take out.
    pub balance: u64,
    pub session: Session,
    /// IOU shares they hold, and what they were owed when those were issued.
    pub iou_shares: u128,
    pub iou_basis: u64,
    /// Who paid this account's rent; it goes back to them if the account is ever closed.
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// A band of a bet as placed: `lo` to `hi` (8 decimals, on the grid), `second` seconds after it opens, staking
/// `stake` and paying `rung` (x100) if the price reaches it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct BetSection {
    pub second: u8,
    pub lo: u64,
    pub hi: u64,
    pub stake: u64,
    pub rung: u16,
}

/// One bet: a piece of a drawing as placed. It lives until every band in it is decided, then is closed and its rent
/// goes back to whoever paid it.
#[account]
pub struct Bet {
    /// The player's wallet.
    pub player: Pubkey,
    pub drawing: u64,
    pub index: u32,
    pub market: u8,
    pub difficulty: u8,
    pub live_mask: u32,
    pub hit_mask: u32,
    /// The second it opened on, ms.
    pub open_at: i64,
    pub per_dot: u64,
    pub unit: u64,
    pub stake: u64,
    pub rent_payer: Pubkey,
    pub sections: Vec<BetSection>,
}

impl Bet {
    pub const FIXED: usize = 8 + 32 + 8 + 4 + 1 + 1 + 4 + 4 + 8 + 8 + 8 + 8 + 32 + 4;
    pub fn space(sections: usize) -> usize {
        Self::FIXED + sections * BetSection::INIT_SPACE
    }
}
