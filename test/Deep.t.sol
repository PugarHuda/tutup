// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Tutup, IERC20, IWIF} from "../src/Tutup.sol";
import {Token} from "./Tutup.t.sol";

/// A token that calls back into Tutup on every transfer, like an ERC-777 hook would.
contract ReentrantToken is Token {
    Tutup public target;
    bytes public payload;
    bool public attempted;
    bytes4 public lastError;

    function arm(Tutup t, bytes calldata p) external {
        target = t;
        payload = p;
    }

    function _hook() internal {
        if (address(target) == address(0) || attempted) return;
        attempted = true;
        (bool ok, bytes memory r) = address(target).call(payload);
        require(!ok, "re-entry succeeded");
        lastError = bytes4(r);
    }

    function transfer(address to, uint256 a) external override returns (bool) {
        _hook();
        _move(msg.sender, to, a);
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external override returns (bool) {
        _hook();
        allowance[f][msg.sender] -= a;
        _move(f, to, a);
        return true;
    }
}

contract DeepTest is Test {
    Tutup t;
    Token wif;
    Token usdg;
    address seller = address(0x5e11);
    uint128 constant BOND = 50e18;

    function setUp() public {
        wif = new Token();
        usdg = new Token();
        t = new Tutup(IWIF(address(wif)), 100e18, BOND);
        wif.mint(seller, 1_000e18);
        vm.prank(seller);
        wif.approve(address(t), type(uint256).max);
    }

    function _bidder(uint256 i) internal returns (address b) {
        b = address(uint160(0xB000 + i));
        wif.mint(b, BOND);
        usdg.mint(b, 1_000_000e18);
        vm.startPrank(b);
        wif.approve(address(t), type(uint256).max);
        usdg.approve(address(t), type(uint256).max);
        vm.stopPrank();
    }

    function _list(IERC20 lot, uint128 amount, uint128 minSold) internal returns (uint256 id) {
        vm.prank(seller);
        id = t.create(lot, IERC20(address(usdg)), amount, 1e18, BOND, minSold, 1 hours, 1 hours, address(0));
    }

    function test_minSoldNotMetRefundsEveryone() public {
        Token lot = new Token();
        lot.mint(seller, 10e18);
        vm.prank(seller);
        lot.approve(address(t), type(uint256).max);
        uint256 id = _list(IERC20(address(lot)), 10e18, 6e18); // sell only if 6+ can clear

        address a = _bidder(1);
        address b = _bidder(2);
        bytes32 ha = t.commitHash(id, a, 3e18, 5e18, "a");
        bytes32 hb = t.commitHash(id, b, 2e18, 4e18, "b");
        vm.prank(a);
        t.commit(id, ha);
        vm.prank(b);
        t.commit(id, hb);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(a);
        t.reveal(id, 3e18, 5e18, "a");
        vm.prank(b);
        t.reveal(id, 2e18, 4e18, "b");
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.settle(id);

        assertEq(lot.balanceOf(seller), 10e18, "demand of 5 < minSold 6: lot back");
        assertEq(usdg.balanceOf(a), 1_000_000e18, "a refunded");
        assertEq(usdg.balanceOf(b), 1_000_000e18, "b refunded");
        (uint128 price,,,) = t.lastPrint(address(lot), address(usdg));
        assertEq(price, 0, "no sale, no print");
    }

    function test_minSoldMetSells() public {
        Token lot = new Token();
        lot.mint(seller, 10e18);
        vm.prank(seller);
        lot.approve(address(t), type(uint256).max);
        uint256 id = _list(IERC20(address(lot)), 10e18, 4e18);
        address a = _bidder(1);
        bytes32 ha = t.commitHash(id, a, 5e18, 5e18, "a");
        vm.prank(a);
        t.commit(id, ha);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(a);
        t.reveal(id, 5e18, 5e18, "a");
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.settle(id);
        assertEq(lot.balanceOf(a), 5e18);
        assertEq(lot.balanceOf(seller), 5e18);
    }

    function test_minSoldAboveLotRejected() public {
        Token lot = new Token();
        lot.mint(seller, 1e18);
        vm.prank(seller);
        lot.approve(address(t), type(uint256).max);
        vm.prank(seller);
        vm.expectRevert(Tutup.BadParams.selector);
        t.create(IERC20(address(lot)), IERC20(address(usdg)), 1e18, 1, BOND, 2e18, 1 hours, 1 hours, address(0));
    }

    function test_reentryFromTokenHookIsBlocked() public {
        ReentrantToken lot = new ReentrantToken();
        lot.mint(seller, 10e18);
        vm.prank(seller);
        lot.approve(address(t), type(uint256).max);
        // while Tutup pulls the lot in create(), the token tries to call settle(0) on the same contract
        lot.arm(t, abi.encodeCall(Tutup.settle, (0)));
        _list(IERC20(address(lot)), 10e18, 0);
        assertTrue(lot.attempted(), "hook ran");
        assertEq(lot.lastError(), Tutup.Reentrancy.selector, "re-entry rejected by the lock");
    }

    function test_reentryDuringSettlePayoutIsBlocked() public {
        ReentrantToken lot = new ReentrantToken();
        lot.mint(seller, 10e18);
        vm.prank(seller);
        lot.approve(address(t), type(uint256).max);
        uint256 id = _list(IERC20(address(lot)), 10e18, 0);
        address a = _bidder(1);
        bytes32 ha = t.commitHash(id, a, 10e18, 2e18, "a");
        vm.prank(a);
        t.commit(id, ha);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(a);
        t.reveal(id, 10e18, 2e18, "a");
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        // when settle pushes the lot to the winner, the token tries to claim from Tutup
        lot.arm(t, abi.encodeCall(Tutup.claim, (IERC20(address(lot)))));
        t.settle(id);
        assertEq(lot.lastError(), Tutup.Reentrancy.selector);
        assertEq(lot.balanceOf(a), 10e18, "winner still paid");
    }

    /// The worst case: 64 revealed bids, all filling. It must fit well under a block.
    function test_gasSettleFullBook() public {
        Token lot = new Token();
        lot.mint(seller, 64e18);
        vm.prank(seller);
        lot.approve(address(t), type(uint256).max);
        uint256 id = _list(IERC20(address(lot)), 64e18, 0);
        for (uint256 i; i < 64; i++) {
            address b = _bidder(i);
            uint128 price = uint128(2e18 + (i * 7919 % 64) * 1e16); // scrambled order for the sort
            bytes32 h = t.commitHash(id, b, 1e18, price, bytes32(i));
            vm.prank(b);
            t.commit(id, h);
        }
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        for (uint256 i; i < 64; i++) {
            vm.prank(address(uint160(0xB000 + i)));
            t.reveal(id, 1e18, uint128(2e18 + (i * 7919 % 64) * 1e16), bytes32(i));
        }
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        uint256 g = gasleft();
        t.settle(id);
        uint256 used = g - gasleft();
        emit log_named_uint("settle gas, 64 bids", used);
        assertLt(used, 10_000_000, "settle fits easily in a Robinhood Chain block");
        assertEq(lot.balanceOf(address(t)), 0);
    }
}

/// Random sequences of create / commit / reveal / settle. After every step the contract must hold exactly
/// what it owes: escrowed lots, escrowed payments and outstanding bonds, and nothing else.
contract Handler is Test {
    Tutup public t;
    Token public wif;
    Token public lot;
    Token public usdg;
    address public seller = address(0x5e11);
    address[4] public bidders = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];

    uint256 public ghostLot;
    uint256 public ghostQuote;
    uint256 public ghostBonds;
    mapping(uint256 => mapping(address => uint128)) qtyOf;
    mapping(uint256 => mapping(address => uint128)) priceOf;
    mapping(uint256 => uint256) escrowOf;
    mapping(uint256 => uint256) bondsOf;

    constructor(Tutup _t, Token _wif, Token _lot, Token _usdg) {
        t = _t;
        wif = _wif;
        lot = _lot;
        usdg = _usdg;
    }

    function create(uint128 amount) external {
        amount = uint128(bound(amount, 1e18, 20e18));
        lot.mint(seller, amount);
        wif.mint(seller, 100e18);
        vm.prank(seller);
        t.create(IERC20(address(lot)), IERC20(address(usdg)), amount, 1e18, 50e18, 0, 1 hours, 1 hours, address(0));
        ghostLot += amount;
    }

    function commit(uint256 who, uint128 qty, uint128 price) external {
        uint256 n = t.auctionCount();
        if (n == 0) return;
        uint256 id = n - 1;
        (,,,, uint128 lotAmount,,, , uint64 commitEnd,,,,) = t.auctions(id);
        address b = bidders[who % 4];
        if (vm.getBlockTimestamp() >= commitEnd || t.commitOf(id, b) != 0) return;
        qty = uint128(bound(qty, 1, lotAmount));
        price = uint128(bound(price, 1e18, 5e18));
        wif.mint(b, 50e18);
        usdg.mint(b, uint256(qty) * price / 1e18 + 1);
        vm.startPrank(b);
        wif.approve(address(t), type(uint256).max);
        usdg.approve(address(t), type(uint256).max);
        t.commit(id, t.commitHash(id, b, qty, price, bytes32(uint256(uint160(b)))));
        vm.stopPrank();
        qtyOf[id][b] = qty;
        priceOf[id][b] = price;
        ghostBonds += 50e18;
        bondsOf[id] += 50e18;
    }

    function reveal(uint256 who) external {
        uint256 n = t.auctionCount();
        if (n == 0) return;
        uint256 id = n - 1;
        address b = bidders[who % 4];
        (,,,,,,, , uint64 commitEnd, uint64 revealEnd,,,) = t.auctions(id);
        uint256 now_ = vm.getBlockTimestamp();
        if (now_ < commitEnd || now_ >= revealEnd || t.commitOf(id, b) == 0) return;
        vm.prank(b);
        t.reveal(id, qtyOf[id][b], priceOf[id][b], bytes32(uint256(uint160(b))));
        uint256 c = (uint256(qtyOf[id][b]) * priceOf[id][b] + 1e18 - 1) / 1e18;
        ghostQuote += c;
        escrowOf[id] += c;
        ghostBonds -= 50e18;
        bondsOf[id] -= 50e18;
    }

    function settle() external {
        uint256 n = t.auctionCount();
        if (n == 0) return;
        uint256 id = n - 1;
        (,,,, uint128 lotAmount,,,,, uint64 revealEnd,,, bool settled) = t.auctions(id);
        if (settled || vm.getBlockTimestamp() < revealEnd) return;
        t.settle(id);
        ghostLot -= lotAmount; // every unit goes to a winner or back to the seller
        ghostQuote -= escrowOf[id]; // every escrowed unit goes to the seller or back to a bidder
        ghostBonds -= bondsOf[id]; // unrevealed bonds burn
        escrowOf[id] = 0;
        bondsOf[id] = 0;
    }

    function wait(uint256 s) external {
        vm.warp(vm.getBlockTimestamp() + bound(s, 1 minutes, 90 minutes));
    }
}

contract InvariantTest is Test {
    Handler h;
    Tutup t;
    Token wif;
    Token lot;
    Token usdg;

    function setUp() public {
        wif = new Token();
        lot = new Token();
        usdg = new Token();
        t = new Tutup(IWIF(address(wif)), 100e18, 50e18);
        h = new Handler(t, wif, lot, usdg);
        vm.prank(h.seller());
        lot.approve(address(t), type(uint256).max);
        vm.prank(h.seller());
        wif.approve(address(t), type(uint256).max);
        targetContract(address(h));
    }

    function invariant_escrowMatchesObligations() public view {
        assertEq(lot.balanceOf(address(t)), h.ghostLot(), "lot escrow");
        assertEq(usdg.balanceOf(address(t)), h.ghostQuote(), "payment escrow");
        assertEq(wif.balanceOf(address(t)), h.ghostBonds(), "bonds");
    }
}

import {TutupFeed, ITutupPrints} from "../src/TutupFeed.sol";

contract FeedTest is Test {
    function test_feedReadsPrintLikeChainlink() public {
        Token wif = new Token();
        Token lot = new Token();
        Token usdg = new Token(); // pretend 6 decimals below
        Tutup t = new Tutup(IWIF(address(wif)), 100e18, 50e18);
        TutupFeed f = new TutupFeed(ITutupPrints(address(t)), address(lot), address(usdg), 6, "NVDA / USDG weekend print");

        vm.expectRevert(TutupFeed.NoPrint.selector);
        f.latestRoundData();

        address seller = address(0x5e11);
        address a = address(0xA11CE);
        lot.mint(seller, 1e18);
        wif.mint(seller, 100e18);
        wif.mint(a, 50e18);
        usdg.mint(a, 1_000e6);
        vm.startPrank(seller);
        lot.approve(address(t), type(uint256).max);
        wif.approve(address(t), type(uint256).max);
        uint256 id = t.create(IERC20(address(lot)), IERC20(address(usdg)), 1e18, 100e6, 50e18, 0, 1 hours, 1 hours, address(0));
        vm.stopPrank();
        vm.startPrank(a);
        wif.approve(address(t), type(uint256).max);
        usdg.approve(address(t), type(uint256).max);
        t.commit(id, t.commitHash(id, a, 1e18, 161_250000, "s"));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.reveal(id, 1e18, 161_250000, "s");
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.settle(id);

        (uint80 roundId, int256 answer,, uint256 updatedAt,) = f.latestRoundData();
        assertEq(answer, 161_25000000, "161.25 USDG with 8 decimals, like a Chainlink USD feed");
        assertEq(roundId, id);
        assertEq(updatedAt, vm.getBlockTimestamp());
        assertEq(f.decimals(), 8);
        assertEq(f.latestAnswer(), answer);
    }
}
