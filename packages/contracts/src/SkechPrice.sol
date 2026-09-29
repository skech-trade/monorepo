// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SkechPrice
/// @notice Checks a price signed by the skech engine (`packages/engine`).
/// @dev EIP-712 typed data under the domain {name "skech", version "1", chainId, verifyingContract: this},
/// so a price signed for another chain or another contract does not verify here. The domain is readable
/// through EIP-5267's `eip712Domain()`, which OpenZeppelin's EIP712 provides.
contract SkechPrice is EIP712 {
    /// @notice `Price(string market,uint256 price,uint64 time)`: price with 8 decimals, time in ms, the exchange's.
    bytes32 public constant PRICE_TYPEHASH = keccak256("Price(string market,uint256 price,uint64 time)");

    /// @notice The engine's wallet: the only signer whose prices this contract takes.
    address public immutable engine;
    /// @notice How old a price may be, in seconds, before it is refused.
    uint256 public immutable maxAge;

    error NotEngine(address signer);
    error Stale(uint64 time);

    constructor(address engine_, uint256 maxAge_) EIP712("skech", "1") {
        engine = engine_;
        maxAge = maxAge_;
    }

    /// @notice The EIP-712 digest the engine signs for this price, on this chain, for this contract.
    function hashPrice(string calldata market, uint256 price, uint64 time) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PRICE_TYPEHASH, keccak256(bytes(market)), price, time)));
    }

    /// @notice The price, if the engine signed it for this chain and this contract no more than `maxAge` ago.
    /// @dev Reverts otherwise. A user can hold on to a price that suits them: the age check is what stops that.
    function verify(string calldata market, uint256 price, uint64 time, bytes calldata signature)
        public
        view
        returns (uint256)
    {
        address signer = ECDSA.recover(hashPrice(market, price, time), signature);
        if (signer != engine) revert NotEngine(signer);
        if (time / 1000 + maxAge < block.timestamp) revert Stale(time);
        return price;
    }
}
