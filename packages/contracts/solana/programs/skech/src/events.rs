use anchor_lang::prelude::*;

use crate::state::BetSection;

#[event]
pub struct Deposited {
    pub player: Pubkey,
    pub amount: u64,
    /// Swept from the wallet on its standing approval, rather than sent by it.
    pub swept: bool,
}

#[event]
pub struct Withdrawn {
    pub player: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SessionSet {
    pub player: Pubkey,
    pub key: Pubkey,
    pub valid_until: i64,
    pub allowance: u64,
}

#[event]
pub struct SessionRevoked {
    pub player: Pubkey,
}

/// A piece went in. `refunded` is the stake of bands not offered, which never left the balance.
#[event]
pub struct Placed {
    pub bet: Pubkey,
    pub player: Pubkey,
    pub drawing: u64,
    pub index: u32,
    pub market: u8,
    pub open_at: i64,
    pub per_dot: u64,
    pub unit: u64,
    pub staked: u64,
    pub fee: u64,
    pub refunded: u64,
    pub price_seen: u64,
    pub price_time: i64,
    pub stroke_hash: [u8; 32],
    pub sections: Vec<BetSection>,
}

#[event]
pub struct BarPosted {
    pub market: u8,
    pub second: i64,
    pub prev_close: u64,
    pub high: u64,
    pub low: u64,
    pub close: u64,
}

/// Bands decided: `paid` USDC into the balance, `owed` as IOU.
#[event]
pub struct Settled {
    pub bet: Pubkey,
    pub player: Pubkey,
    pub hit_mask: u32,
    pub miss_mask: u32,
    pub paid: u64,
    pub owed: u64,
    /// Every band decided: the bet is closed.
    pub closed: bool,
    /// Bands whose second can no longer be posted, given back by `expire`, and what they gave back (in `paid` and
    /// `owed` with the rest).
    pub expired_mask: u32,
    pub refunded: u64,
}

/// `to` is owed `value` as IOU shares; the house when `to` is the default key.
#[event]
pub struct Owed {
    pub to: Pubkey,
    pub value: u64,
    pub shares: u128,
}

#[event]
pub struct Redeemed {
    pub holder: Pubkey,
    pub by: Pubkey,
    pub shares: u128,
    pub value: u64,
    pub cut: u64,
}

#[event]
pub struct FeesCollected {
    pub amount: u64,
}

#[event]
pub struct MarketSet {
    pub market: u8,
    pub name: String,
    pub active: bool,
    pub difficulty: u8,
}

#[event]
pub struct ConfigSet {
    pub config: crate::state::Config,
}
