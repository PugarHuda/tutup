// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Tutup, IWIF} from "../src/Tutup.sol";

contract Deploy is Script {
    function run() external returns (Tutup t) {
        vm.startBroadcast();
        // 100 WIF burned per listing, 50 WIF bond per sealed bid
        t = new Tutup(IWIF(0x5173b8eA6923c2d40267890D45C46a3480954773), 100e18, 50e18);
        vm.stopBroadcast();
    }
}
