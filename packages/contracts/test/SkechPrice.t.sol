// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SkechPrice} from "../src/SkechPrice.sol";

contract SkechPriceTest is Test {
    // The vector `packages/engine/src/quote.rs` signs: anvil's first key, chain 31337, the contract at VERIFIER.
    uint256 constant KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address constant ENGINE = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant VERIFIER = 0x5Ec400000000000000000000000000000000C0De;
    uint256 constant PRICE = 8_359_144_000_000;
    uint64 constant TIME = 1_790_629_278_967;
    bytes constant SIG =
        hex"4078c8f2b1604da6d60a1f986b1430ea682b15e27f1b0c18b286742f694c1b9b289c1bf1a51cddfa72479675e8751f700e607290624c342878570f57704ebf8e1c";
    uint256 constant MAX_AGE = 5;

    SkechPrice oracle;

    function setUp() public {
        deployCodeTo("SkechPrice.sol:SkechPrice", abi.encode(ENGINE, MAX_AGE), VERIFIER);
        oracle = SkechPrice(VERIFIER);
        vm.warp(TIME / 1000 + 1);
    }

    function test_takesTheEnginesSignature() public view {
        assertEq(vm.addr(KEY), ENGINE);
        assertEq(oracle.verify("BTC-USD", PRICE, TIME, SIG), PRICE);
    }

    function test_refusesAChangedPrice() public {
        vm.expectPartialRevert(SkechPrice.NotEngine.selector);
        oracle.verify("BTC-USD", PRICE + 1, TIME, SIG);
    }

    function test_refusesAChangedTimeOrMarket() public {
        vm.expectPartialRevert(SkechPrice.NotEngine.selector);
        oracle.verify("BTC-USD", PRICE, TIME + 1, SIG);
        vm.expectPartialRevert(SkechPrice.NotEngine.selector);
        oracle.verify("ETH-USD", PRICE, TIME, SIG);
    }

    function test_refusesAnotherChain() public {
        vm.chainId(8453);
        vm.expectPartialRevert(SkechPrice.NotEngine.selector);
        oracle.verify("BTC-USD", PRICE, TIME, SIG);
    }

    function test_refusesAnotherContract() public {
        SkechPrice other = new SkechPrice(ENGINE, MAX_AGE);
        vm.expectPartialRevert(SkechPrice.NotEngine.selector);
        other.verify("BTC-USD", PRICE, TIME, SIG);
    }

    function test_refusesAStalePrice() public {
        vm.warp(TIME / 1000 + MAX_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(SkechPrice.Stale.selector, TIME));
        oracle.verify("BTC-USD", PRICE, TIME, SIG);
    }

    function test_refusesAnotherSigner() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xbad, oracle.hashPrice("BTC-USD", PRICE, TIME));
        vm.expectRevert(abi.encodeWithSelector(SkechPrice.NotEngine.selector, vm.addr(0xbad)));
        oracle.verify("BTC-USD", PRICE, TIME, abi.encodePacked(r, s, v));
    }

    /// EIP-5267: wallets and SDKs read the domain from the contract itself.
    function test_publishesItsDomain() public view {
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) =
            oracle.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "skech");
        assertEq(version, "1");
        assertEq(chainId, 31337);
        assertEq(verifying, VERIFIER);
    }

    function testFuzz_takesAnyPriceTheEngineSigns(uint256 price, uint64 time) public {
        time = uint64(bound(time, 1_000, type(uint64).max / 2));
        vm.warp(time / 1000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, oracle.hashPrice("BTC-USD", price, time));
        assertEq(oracle.verify("BTC-USD", price, time, abi.encodePacked(r, s, v)), price);
    }
}
