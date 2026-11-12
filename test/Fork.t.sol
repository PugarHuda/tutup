// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Tutup, IERC20, IWIF} from "../src/Tutup.sol";

interface IERC20Full {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/// Runs against Robinhood Chain mainnet: FORK_RPC=<rpc> forge test --match-contract Fork
contract ForkTest is Test {
    address constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA_FEED_247 = 0x321A36e441DfBadA01Aa6f9884F14a344E133D1F;

    function test_realTokens() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);

        Tutup t = new Tutup(IWIF(WIF), 100e18, 50e18);
        address seller = makeAddr("seller");
        address alice = makeAddr("alice");

        deal(WIF, seller, 1_000e18);
        deal(WIF, alice, 1_000e18);
        deal(NVDA, seller, 1e18);
        deal(USDG, alice, 1_000e6);

        uint256 supply0 = IERC20Full(WIF).totalSupply();

        vm.startPrank(seller);
        IERC20Full(WIF).approve(address(t), type(uint256).max);
        IERC20Full(NVDA).approve(address(t), type(uint256).max);
        uint256 id = t.create(IERC20(NVDA), IERC20(USDG), 1e18, 100e6, 50e18, 0, 1 hours, 1 hours, NVDA_FEED_247);
        vm.stopPrank();

        assertEq(IERC20Full(WIF).totalSupply(), supply0 - 100e18, "real WIF burned");

        bytes32 h = t.commitHash(id, alice, 1e18, 150e6, bytes32("s"));
        vm.startPrank(alice);
        IERC20Full(WIF).approve(address(t), type(uint256).max);
        IERC20Full(USDG).approve(address(t), type(uint256).max);
        t.commit(id, h);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.reveal(id, 1e18, 150e6, bytes32("s"));
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.settle(id);

        assertEq(IERC20Full(NVDA).balanceOf(alice), 1e18);
        assertEq(IERC20Full(USDG).balanceOf(seller), 150e6);
        (uint128 printPrice,,,) = t.lastPrint(NVDA, USDG);
        assertEq(printPrice, 150e6, "weekend print recorded");
    }
}
