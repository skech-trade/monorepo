//! The engine as an oracle: every price it streams is signed by its wallet as
//! EIP-712 typed data, bound by the domain to one chain id and one verifying
//! contract, so a contract can check a price came from here, for itself, on
//! its own chain, and was not changed on the way.

use alloy_primitives::{Address, U256, hex};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{Eip712Domain, SolStruct, sol};
use serde_json::{Value, json};

pub const NAME: &str = "skech";
pub const VERSION: &str = "1";

sol! {
    /// What a contract rebuilds and recovers: `price` has 8 decimals, `time` is the exchange's, in ms.
    struct Price {
        string market;
        uint256 price;
        uint64 time;
    }
}

pub struct Quoter {
    wallet: PrivateKeySigner,
    domain: Eip712Domain,
    chain_id: u64,
    contract: Address,
}

impl Quoter {
    pub fn new(wallet: PrivateKeySigner, chain_id: u64, contract: Address) -> Self {
        let domain = Eip712Domain::new(Some(NAME.into()), Some(VERSION.into()), Some(U256::from(chain_id)), Some(contract), None);
        Self { wallet, domain, chain_id, contract }
    }

    pub fn address(&self) -> Address {
        self.wallet.address()
    }

    /// Everything of an `eth_signTypedData_v4` payload but the message: each price carries its own.
    pub fn typed_data(&self) -> Value {
        json!({
            "domain": {
                "name": NAME,
                "version": VERSION,
                "chainId": self.chain_id,
                "verifyingContract": self.contract.to_checksum(None),
            },
            "primaryType": "Price",
            "types": {
                "EIP712Domain": [
                    { "name": "name", "type": "string" },
                    { "name": "version", "type": "string" },
                    { "name": "chainId", "type": "uint256" },
                    { "name": "verifyingContract", "type": "address" },
                ],
                "Price": [
                    { "name": "market", "type": "string" },
                    { "name": "price", "type": "uint256" },
                    { "name": "time", "type": "uint64" },
                ],
            },
        })
    }

    /// 0x-prefixed 65-byte r‖s‖v (v 27 or 28, s in the low half) over the EIP-712 digest of the price.
    pub fn sign(&self, market: &str, price_e8: u128, time: u64) -> Option<String> {
        let hash = Price { market: market.into(), price: U256::from(price_e8), time }.eip712_signing_hash(&self.domain);
        let sig = self.wallet.sign_hash_sync(&hash).ok()?;
        Some(hex::encode_prefixed(sig.as_bytes()))
    }
}

/// A decimal string as an integer with 8 decimals, exactly, never through a float: "83457.55" is 8345755000000.
pub fn e8(price: &str) -> Option<u128> {
    let (whole, frac) = price.split_once('.').unwrap_or((price, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || frac.len() > 8 || !digits(whole) || !digits(frac) {
        return None;
    }
    let frac: u128 = format!("{frac:0<8}").parse().ok()?;
    whole.parse::<u128>().ok()?.checked_mul(100_000_000)?.checked_add(frac)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e8_is_exact() {
        assert_eq!(e8("83457.55"), Some(8_345_755_000_000));
        assert_eq!(e8("83457"), Some(8_345_700_000_000));
        assert_eq!(e8("0.00000001"), Some(1));
        assert_eq!(e8("0.000000001"), None);
        assert_eq!(e8("-1"), None);
        assert_eq!(e8(".5"), None);
        assert_eq!(e8("1e3"), None);
    }

    /// The same vector `packages/evm-contracts/test/SkechPrice.t.sol` recovers on chain:
    /// anvil's first key, chain 31337, the contract at `VERIFIER`.
    pub const VERIFIER: &str = "0x5ec400000000000000000000000000000000c0de";
    pub const KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    #[test]
    fn signs_the_vector_the_contract_checks() {
        let q = Quoter::new(KEY.parse().unwrap(), 31337, VERIFIER.parse().unwrap());
        assert_eq!(q.address().to_checksum(None), "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
        // RFC 6979: the same key and digest always give the same signature.
        let sig = q.sign("BTC-USD", 8_359_144_000_000, 1_790_629_278_967).unwrap();
        assert_eq!(sig, "0x4078c8f2b1604da6d60a1f986b1430ea682b15e27f1b0c18b286742f694c1b9b289c1bf1a51cddfa72479675e8751f700e607290624c342878570f57704ebf8e1c");
    }
}
