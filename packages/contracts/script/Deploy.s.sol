// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SkechPrice} from "../src/SkechPrice.sol";

/// forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <deployer>
/// ENGINE_ADDRESS: the engine's signer (its `hello.signer`). MAX_AGE: seconds, default 5.
/// Then set ENGINE_CHAIN_ID and ENGINE_VERIFYING_CONTRACT in .env.local so the engine signs for it.
contract Deploy is Script {
    function run() external returns (SkechPrice oracle) {
        address engine = vm.envAddress("ENGINE_ADDRESS");
        uint256 maxAge = vm.envOr("MAX_AGE", uint256(5));
        vm.startBroadcast();
        oracle = new SkechPrice(engine, maxAge);
        vm.stopBroadcast();
        console.log("SkechPrice", address(oracle), "chain", block.chainid);
    }
}
