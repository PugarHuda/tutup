// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Tutup, IERC20, IWIF} from "../src/Tutup.sol";

contract Token {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public frozen; // like USDG's freeze
    uint256 public totalSupply;
    uint256 public feeBps; // fee-on-transfer, off by default

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
        totalSupply += a;
    }

    function freeze(address who, bool f) external {
        frozen[who] = f;
    }

    function setFee(uint256 bps) external {
        feeBps = bps;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external virtual returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external virtual returns (bool) {
        allowance[f][msg.sender] -= a;
        _move(f, to, a);
        return true;
    }

    function _move(address f, address to, uint256 a) internal {
        require(!frozen[f] && !frozen[to], "frozen");
        balanceOf[f] -= a;
        uint256 fee = a * feeBps / 10_000;
        balanceOf[to] += a - fee;
        totalSupply -= fee;
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
    uint128 constant BOND = 50e18;

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
        return _createBond(amount, reserve, BOND);
    }

    function _createBond(uint128 amount, uint128 reserve, uint128 bond) internal returns (uint256 id) {
        vm.prank(seller);
        id = t.create(IERC20(address(lot)), IERC20(address(usdg)), amount, reserve, bond, 0, 1 hours, 1 hours, address(feed));
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

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _reveal(id, carol, 5e18, 150e18); // reveal order must not matter
        _reveal(id, alice, 6e18, 170e18);
        _reveal(id, bob, 6e18, 160e18);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
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

        (uint128 price, uint128 sold,, uint64 auctionId) = t.lastPrint(address(lot), address(usdg));
        assertEq(price, 160e18, "print = clearing price");
        assertEq(sold, 10e18);
        assertEq(auctionId, id);
    }

    function test_unrevealedBondBurnedAndUnsoldReturned() public {
        uint256 id = _create(10e18, 100e18);
        _commit(id, alice, 3e18, 120e18);
        _commit(id, bob, 3e18, 200e18); // never reveals

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _reveal(id, alice, 3e18, 120e18);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.settle(id);

        assertEq(wif.balanceOf(bob), 1_000e18 - BOND);
        assertEq(t.totalBurned(), FEE + BOND);
        assertEq(lot.balanceOf(seller), 7e18, "unsold lot back to seller");
        assertEq(usdg.balanceOf(seller), 1_000_000e18 + 3 * 120e18);
    }

    function test_sellerSetsBondAboveFloor() public {
        vm.prank(seller);
        vm.expectRevert(Tutup.BadParams.selector);
        t.create(IERC20(address(lot)), IERC20(address(usdg)), 1e18, 1, BOND - 1, 0, 1 hours, 1 hours, address(0));

        uint256 id = _createBond(10e18, 100e18, 300e18); // a seller can price out griefers
        _commit(id, alice, 1e18, 150e18);
        assertEq(wif.balanceOf(alice), 1_000e18 - 300e18);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        t.settle(id);
        assertEq(t.totalBurned(), FEE + 300e18, "the seller's bond is what burns");
    }

    function test_sellerCannotBid() public {
        uint256 id = _create(10e18, 100e18);
        vm.prank(seller);
        vm.expectRevert(Tutup.SellerCannotBid.selector);
        t.commit(id, bytes32(uint256(1)));
    }

    function test_cancelOnlyBeforeAnyBid() public {
        uint256 id = _create(10e18, 100e18);
        vm.prank(alice);
        vm.expectRevert(Tutup.NotSeller.selector);
        t.cancel(id);

        vm.prank(seller);
        t.cancel(id);
        assertEq(lot.balanceOf(seller), 10e18, "lot back");
        assertEq(t.totalBurned(), FEE, "fee stays burned");

        vm.prank(alice);
        vm.expectRevert(Tutup.WrongPhase.selector);
        t.commit(id, bytes32(uint256(1)));

        lot.mint(seller, 1e18);
        uint256 id2 = _create(1e18, 100e18);
        _commit(id2, alice, 1e18, 150e18);
        vm.prank(seller);
        vm.expectRevert(Tutup.WrongPhase.selector);
        t.cancel(id2);
    }

    function test_frozenRecipientCannotLockSettlement() public {
        uint256 id = _create(10e18, 100e18);
        _commit(id, alice, 6e18, 170e18);
        _commit(id, bob, 6e18, 160e18);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _reveal(id, alice, 6e18, 170e18);
        _reveal(id, bob, 6e18, 160e18);

        usdg.freeze(alice, true); // alice's USDG refund will fail
        lot.freeze(bob, true); // bob's lot delivery will fail
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.settle(id); // must not revert

        assertEq(lot.balanceOf(alice), 6e18, "alice still gets her lot");
        assertEq(t.owed(address(usdg), alice), 6 * 10e18, "alice's refund is held for her");
        assertEq(t.owed(address(lot), bob), 4e18, "bob's lot is held for him");
        assertEq(usdg.balanceOf(seller), 1_000_000e18 + 10 * 160e18, "seller paid regardless");

        lot.freeze(bob, false);
        vm.prank(bob);
        t.claim(IERC20(address(lot)));
        assertEq(lot.balanceOf(bob), 4e18);
        assertEq(t.owed(address(lot), bob), 0);

        vm.prank(bob);
        vm.expectRevert(Tutup.NothingOwed.selector);
        t.claim(IERC20(address(lot)));
    }

    function test_feeOnTransferLotRefused() public {
        lot.setFee(100); // 1%
        vm.prank(seller);
        vm.expectRevert(Tutup.TransferFailed.selector);
        t.create(IERC20(address(lot)), IERC20(address(usdg)), 1e18, 1, BOND, 0, 1 hours, 1 hours, address(0));
    }

    function test_noBids() public {
        uint256 id = _create(10e18, 100e18);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        t.settle(id);
        assertEq(lot.balanceOf(seller), 10e18);
        (uint128 price,,,) = t.lastPrint(address(lot), address(usdg));
        assertEq(price, 0, "no sale, no print");
    }

    function test_phasesEnforced() public {
        uint256 id = _create(10e18, 100e18);
        _commit(id, alice, 1e18, 150e18);

        vm.expectRevert(Tutup.WrongPhase.selector);
        _reveal(id, alice, 1e18, 150e18); // still commit phase

        vm.prank(alice);
        vm.expectRevert(Tutup.AlreadyCommitted.selector);
        t.commit(id, bytes32(uint256(1)));

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(bob);
        vm.expectRevert(Tutup.WrongPhase.selector);
        t.commit(id, bytes32(uint256(1))); // commits closed

        vm.expectRevert(Tutup.BadReveal.selector);
        _reveal(id, alice, 1e18, 151e18); // different from the commit

        vm.prank(carol);
        vm.expectRevert(Tutup.NoCommit.selector);
        t.reveal(id, 1e18, 150e18, bytes32(0));

        vm.expectRevert(Tutup.WrongPhase.selector);
        t.settle(id); // reveals still open

        _reveal(id, alice, 1e18, 150e18);
        vm.expectRevert(Tutup.NoCommit.selector);
        _reveal(id, alice, 1e18, 150e18); // can't reveal twice

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectRevert(Tutup.WrongPhase.selector);
        _reveal(id, alice, 1e18, 150e18); // reveals closed
        t.settle(id);
        vm.expectRevert(Tutup.WrongPhase.selector);
        t.settle(id);
    }

    function test_belowReserveCannotReveal() public {
        uint256 id = _create(10e18, 100e18);
        _commit(id, alice, 1e18, 99e18);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectRevert(Tutup.BadReveal.selector);
        _reveal(id, alice, 1e18, 99e18);
    }

    function test_maxBids() public {
        uint256 id = _create(10e18, 100e18);
        for (uint256 i; i < t.MAX_BIDS(); i++) {
            address b = address(uint160(0x1000 + i));
            wif.mint(b, BOND);
            vm.startPrank(b);
            wif.approve(address(t), BOND);
            t.commit(id, bytes32(i + 1));
            vm.stopPrank();
        }
        vm.prank(alice);
        vm.expectRevert(Tutup.TooManyBids.selector);
        t.commit(id, bytes32(uint256(1)));
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        t.settle(id);
        assertEq(t.totalBurned(), FEE + 64 * uint256(BOND), "a full book of fake bids burns 64 bonds");
    }

    function test_tieIsNotFirstComeFirstServed() public {
        uint256 id = _create(1e18, 100e18);
        _commit(id, alice, 1e18, 150e18);
        _commit(id, bob, 1e18, 150e18);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _reveal(id, alice, 1e18, 150e18);
        _reveal(id, bob, 1e18, 150e18);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.settle(id);
        address winner = keccak256(abi.encode(id, alice)) < keccak256(abi.encode(id, bob)) ? alice : bob;
        assertEq(lot.balanceOf(winner), 1e18);
    }

    function testFuzz_conservation(uint128 q1, uint128 q2, uint128 q3, uint128 p1, uint128 p2, uint128 p3) public {
        q1 = uint128(bound(q1, 1, 10e18));
        q2 = uint128(bound(q2, 1, 10e18));
        q3 = uint128(bound(q3, 1, 10e18));
        p1 = uint128(bound(p1, 100e18, 1_000e18));
        p2 = uint128(bound(p2, 100e18, 1_000e18));
        p3 = uint128(bound(p3, 100e18, 1_000e18));
        uint256 id = _create(10e18, 100e18);
        _commit(id, alice, q1, p1);
        _commit(id, bob, q2, p2);
        _commit(id, carol, q3, p3);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _reveal(id, alice, q1, p1);
        _reveal(id, bob, q2, p2);
        _reveal(id, carol, q3, p3);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        t.settle(id);
        assertEq(lot.balanceOf(alice) + lot.balanceOf(bob) + lot.balanceOf(carol) + lot.balanceOf(seller), 10e18);
        assertEq(usdg.balanceOf(alice) + usdg.balanceOf(bob) + usdg.balanceOf(carol) + usdg.balanceOf(seller), 4_000_000e18);
        assertEq(usdg.balanceOf(address(t)), 0);
        assertEq(lot.balanceOf(address(t)), 0);
        // nobody pays more than they bid
        (uint128 clearing,,,) = t.lastPrint(address(lot), address(usdg));
        assertLe(clearing, p1 > p2 ? (p1 > p3 ? p1 : p3) : (p2 > p3 ? p2 : p3));
    }
}
