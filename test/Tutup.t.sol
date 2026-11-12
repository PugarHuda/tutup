// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Tutup, IERC20, IWIF} from "../src/Tutup.sol";

contract Token {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
        totalSupply += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }

    function burn(uint256 a) external {
        balanceOf[msg.sender] -= a;
        totalSupply -= a;
    }
}

contract Feed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 160e8, 0, block.timestamp - 1 days, 1);
    }
}

contract TutupTest is Test {
    Tutup t;
    Token wif;
    Token lot; // a Stock Token
    Token usdg;
    Feed feed;
    address seller = address(0x5e11);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    uint256 constant FEE = 100e18;
    uint256 constant BOND = 50e18;

    function setUp() public {
        wif = new Token();
        lot = new Token();
        usdg = new Token();
        feed = new Feed();
        t = new Tutup(IWIF(address(wif)), FEE, BOND);
        address[4] memory who = [seller, alice, bob, carol];
        for (uint256 i; i < 4; i++) {
            wif.mint(who[i], 1_000e18);
            usdg.mint(who[i], 1_000_000e18);
            vm.startPrank(who[i]);
            wif.approve(address(t), type(uint256).max);
            usdg.approve(address(t), type(uint256).max);
            lot.approve(address(t), type(uint256).max);
            vm.stopPrank();
        }
        lot.mint(seller, 10e18);
    }

    function _create(uint128 amount, uint128 reserve) internal returns (uint256 id) {
        vm.prank(seller);
        id = t.create(IERC20(address(lot)), IERC20(address(usdg)), amount, reserve, 1 hours, 1 hours, address(feed));
    }

    function _commit(uint256 id, address who, uint128 qty, uint128 price) internal {
        bytes32 h = t.commitHash(id, who, qty, price, bytes32(uint256(uint160(who))));
        vm.prank(who);
        t.commit(id, h);
    }

    function _reveal(uint256 id, address who, uint128 qty, uint128 price) internal {
        vm.prank(who);
        t.reveal(id, qty, price, bytes32(uint256(uint160(who))));
    }

    function test_uniformPriceAndPartialFill() public {
        uint256 id = _create(10e18, 100e18);
        assertEq(wif.totalSupply(), 4_000e18 - FEE, "listing fee burned");

        _commit(id, alice, 6e18, 170e18);
        _commit(id, bob, 6e18, 160e18);
        _commit(id, carol, 5e18, 150e18);

        vm.warp(block.timestamp + 1 hours);
        _reveal(id, carol, 5e18, 150e18); // reveal order must not matter
        _reveal(id, alice, 6e18, 170e18);
        _reveal(id, bob, 6e18, 160e18);

        vm.warp(block.timestamp + 1 hours);
        t.settle(id);

        // alice fills 6, bob fills the remaining 4, both at bob's 160
        assertEq(lot.balanceOf(alice), 6e18);
        assertEq(lot.balanceOf(bob), 4e18);
        assertEq(lot.balanceOf(carol), 0);
        assertEq(usdg.balanceOf(alice), 1_000_000e18 - 6 * 160e18);
        assertEq(usdg.balanceOf(bob), 1_000_000e18 - 4 * 160e18);
        assertEq(usdg.balanceOf(carol), 1_000_000e18, "loser fully refunded");
        assertEq(usdg.balanceOf(seller), 1_000_000e18 + 10 * 160e18);
        assertEq(wif.balanceOf(alice), 1_000e18, "bond returned");
        assertEq(usdg.balanceOf(address(t)), 0);
        assertEq(lot.balanceOf(address(t)), 0);
    }

    function test_unrevealedBondBurnedAndUnsoldReturned() public {
        uint256 id = _create(10e18, 100e18);
        _commit(id, alice, 3e18, 120e18);
        _commit(id, bob, 3e18, 200e18); // never reveals

        vm.warp(block.timestamp + 1 hours);
        _reveal(id, alice, 3e18, 120e18);
        vm.warp(block.timestamp + 1 hours);
        t.settle(id);

        assertEq(wif.balanceOf(bob), 1_000e18 - BOND);
        assertEq(t.totalBurned(), FEE + BOND);
        assertEq(lot.balanceOf(seller), 7e18, "unsold lot back to seller");
        assertEq(usdg.balanceOf(seller), 1_000_000e18 + 3 * 120e18);
    }

    function test_noBids() public {
        uint256 id = _create(10e18, 100e18);
        vm.warp(block.timestamp + 2 hours);
        t.settle(id);
        assertEq(lot.balanceOf(seller), 10e18);
    }

    function test_phasesEnforced() public {
        uint256 id = _create(10e18, 100e18);
        _commit(id, alice, 1e18, 150e18);

        vm.expectRevert(Tutup.WrongPhase.selector);
        _reveal(id, alice, 1e18, 150e18); // still commit phase

        vm.prank(alice);
        vm.expectRevert(Tutup.AlreadyCommitted.selector);
        t.commit(id, bytes32(uint256(1)));

        vm.warp(block.timestamp + 1 hours);
        vm.prank(bob);
        vm.expectRevert(Tutup.WrongPhase.selector);
        t.commit(id, bytes32(uint256(1))); // commits closed

        vm.expectRevert(Tutup.BadReveal.selector);
        _reveal(id, alice, 1e18, 151e18); // different from the commit

        vm.expectRevert(Tutup.WrongPhase.selector);
        t.settle(id); // reveals still open

        _reveal(id, alice, 1e18, 150e18);
        vm.warp(block.timestamp + 1 hours);
        t.settle(id);
        vm.expectRevert(Tutup.WrongPhase.selector);
        t.settle(id);
    }

    function test_belowReserveCannotReveal() public {
        uint256 id = _create(10e18, 100e18);
        _commit(id, alice, 1e18, 99e18);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(Tutup.BadReveal.selector);
        _reveal(id, alice, 1e18, 99e18);
    }

    function test_tieIsNotFirstComeFirstServed() public {
        uint256 id = _create(1e18, 100e18);
        _commit(id, alice, 1e18, 150e18);
        _commit(id, bob, 1e18, 150e18);
        vm.warp(block.timestamp + 1 hours);
        _reveal(id, alice, 1e18, 150e18);
        _reveal(id, bob, 1e18, 150e18);
        vm.warp(block.timestamp + 1 hours);
        t.settle(id);
        address winner = keccak256(abi.encode(id, alice)) < keccak256(abi.encode(id, bob)) ? alice : bob;
        assertEq(lot.balanceOf(winner), 1e18);
    }

    function testFuzz_conservation(uint128 q1, uint128 q2, uint128 p1, uint128 p2) public {
        q1 = uint128(bound(q1, 1, 10e18));
        q2 = uint128(bound(q2, 1, 10e18));
        p1 = uint128(bound(p1, 100e18, 1_000e18));
        p2 = uint128(bound(p2, 100e18, 1_000e18));
        uint256 id = _create(10e18, 100e18);
        _commit(id, alice, q1, p1);
        _commit(id, bob, q2, p2);
        vm.warp(block.timestamp + 1 hours);
        _reveal(id, alice, q1, p1);
        _reveal(id, bob, q2, p2);
        vm.warp(block.timestamp + 1 hours);
        t.settle(id);
        assertEq(lot.balanceOf(alice) + lot.balanceOf(bob) + lot.balanceOf(seller), 10e18);
        assertEq(usdg.balanceOf(alice) + usdg.balanceOf(bob) + usdg.balanceOf(seller), 3_000_000e18);
        assertEq(usdg.balanceOf(address(t)), 0);
    }
}
