// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IWIF is IERC20 {
    function burn(uint256 amount) external;
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title Tutup — sealed-bid batch auctions for when the market is closed.
/// @notice A seller escrows a lot (a Stock Token, a block of $WIF, any ERC-20). Bidders commit a hash and a
/// $WIF bond while bids are sealed, then reveal and escrow payment. Everyone who wins pays one uniform price:
/// the lowest winning bid. Nobody can win by being first, because order inside a phase does not matter.
/// $WIF: every listing burns a fee, and a bond that is never revealed is burned. No owner, no admin, no pause.
/// Every sale writes a print (last clearing price per lot/quote pair) that other contracts can read.
contract Tutup {
    struct Auction {
        address seller;
        IERC20 lot;
        IERC20 quote;
        address feed; // optional Chainlink reference, recorded at settlement
        uint128 lotAmount;
        uint128 reserve; // minimum price, quote units per 1e18 lot units
        uint128 bond; // $WIF per sealed bid, set by the seller, at least minBond
        uint128 minSold; // if demand can't fill at least this much, nothing sells and everyone is refunded
        uint64 commitEnd;
        uint64 revealEnd;
        uint32 commits;
        uint32 reveals;
        bool settled; // also set on cancel
    }

    struct Bid {
        address bidder;
        uint128 qty;
        uint128 price;
    }

    /// The last clearing price for a lot/quote pair: a weekend price discovered by sealed bids, not a stale feed.
    struct Print {
        uint128 price;
        uint128 sold;
        uint64 at;
        uint64 auctionId;
    }

    uint256 public constant MAX_BIDS = 64; // ponytail: on-chain insertion sort, raise with an off-chain sorted hint
    uint256 public constant MIN_PHASE = 5 minutes;

    IWIF public immutable wif;
    uint256 public immutable listFee;
    uint256 public immutable minBond;

    uint256 public auctionCount;
    uint256 public totalBurned;

    mapping(uint256 => Auction) public auctions;
    mapping(uint256 => mapping(address => bytes32)) public commitOf;
    mapping(uint256 => Bid[]) internal _bids;
    mapping(address => mapping(address => Print)) public lastPrint; // lot => quote => print
    mapping(address => mapping(address => uint256)) public owed; // token => account => amount a payout couldn't deliver
    uint256 private _lock = 1;

    /// One lock for every entry point: escrow is pooled per token, so no token callback may re-enter anywhere.
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    event Created(uint256 indexed id, address indexed seller, address lot, address quote, uint256 lotAmount, uint256 reserve, uint256 bond, uint256 minSold, uint64 commitEnd, uint64 revealEnd, address feed);
    event Cancelled(uint256 indexed id);
    event Committed(uint256 indexed id, address indexed bidder);
    event Revealed(uint256 indexed id, address indexed bidder, uint256 qty, uint256 price);
    event Filled(uint256 indexed id, address indexed bidder, uint256 qty, uint256 paid);
    event Settled(uint256 indexed id, uint256 clearingPrice, uint256 sold, uint256 proceeds, int256 refPrice, uint256 refUpdatedAt);
    event Burned(uint256 indexed id, uint256 amount, string reason);
    event Owed(address indexed token, address indexed to, uint256 amount);
    event Claimed(address indexed token, address indexed to, uint256 amount);

    error BadParams();
    error WrongPhase();
    error AlreadyCommitted();
    error NoCommit();
    error BadReveal();
    error TooManyBids();
    error TransferFailed();
    error SellerCannotBid();
    error NotSeller();
    error NothingOwed();
    error Reentrancy();

    constructor(IWIF _wif, uint256 _listFee, uint256 _minBond) {
        wif = _wif;
        listFee = _listFee;
        minBond = _minBond;
    }

    function create(
        IERC20 lot,
        IERC20 quote,
        uint128 lotAmount,
        uint128 reserve,
        uint128 bond,
        uint128 minSold,
        uint64 commitDuration,
        uint64 revealDuration,
        address feed
    ) external nonReentrant returns (uint256 id) {
        if (
            lotAmount == 0 || minSold > lotAmount || address(lot) == address(quote) || bond < minBond
                || commitDuration < MIN_PHASE || revealDuration < MIN_PHASE
        ) revert BadParams();
        id = auctionCount++;
        uint64 commitEnd = uint64(block.timestamp) + commitDuration;
        auctions[id] = Auction({
            seller: msg.sender,
            lot: lot,
            quote: quote,
            feed: feed,
            lotAmount: lotAmount,
            reserve: reserve,
            bond: bond,
            minSold: minSold,
            commitEnd: commitEnd,
            revealEnd: commitEnd + revealDuration,
            commits: 0,
            reveals: 0,
            settled: false
        });
        _pull(lot, msg.sender, lotAmount);
        if (listFee > 0) {
            _pull(wif, msg.sender, listFee);
            _burn(id, listFee, "listing");
        }
        emit Created(id, msg.sender, address(lot), address(quote), lotAmount, reserve, bond, minSold, commitEnd, commitEnd + revealDuration, feed);
    }

    /// The seller can take the lot back while nobody has bid. The listing fee stays burned.
    function cancel(uint256 id) external nonReentrant {
        Auction storage a = auctions[id];
        if (msg.sender != a.seller) revert NotSeller();
        if (a.settled || a.commits > 0 || block.timestamp >= a.commitEnd) revert WrongPhase();
        a.settled = true;
        _push(a.lot, a.seller, a.lotAmount);
        emit Cancelled(id);
    }

    /// @param hash keccak256(abi.encode(id, bidder, qty, price, salt)) — see commitHash()
    function commit(uint256 id, bytes32 hash) external nonReentrant {
        Auction storage a = auctions[id];
        if (a.lotAmount == 0 || a.settled || block.timestamp >= a.commitEnd) revert WrongPhase();
        if (msg.sender == a.seller) revert SellerCannotBid(); // a seller bid would only move its own clearing price
        if (commitOf[id][msg.sender] != 0) revert AlreadyCommitted();
        if (a.commits >= MAX_BIDS) revert TooManyBids();
        commitOf[id][msg.sender] = hash;
        a.commits++;
        _pull(wif, msg.sender, a.bond);
        emit Committed(id, msg.sender);
    }

    /// Escrows qty * price / 1e18 of the quote token and returns the bond.
    function reveal(uint256 id, uint128 qty, uint128 price, bytes32 salt) external nonReentrant {
        Auction storage a = auctions[id];
        if (block.timestamp < a.commitEnd || block.timestamp >= a.revealEnd) revert WrongPhase();
        bytes32 h = commitOf[id][msg.sender];
        if (h == 0) revert NoCommit();
        if (h != commitHash(id, msg.sender, qty, price, salt)) revert BadReveal();
        if (qty == 0 || qty > a.lotAmount || price < a.reserve) revert BadReveal();
        delete commitOf[id][msg.sender];
        a.reveals++;
        _bids[id].push(Bid(msg.sender, qty, price));
        _pull(a.quote, msg.sender, _cost(qty, price));
        _push(wif, msg.sender, a.bond);
        emit Revealed(id, msg.sender, qty, price);
    }

    /// Anyone can settle once reveals close. Highest prices fill first; all winners pay the marginal price.
    /// A payout that fails (a frozen or blocklisted recipient) is credited to owed[] instead, so one bad
    /// recipient can never lock everyone else's funds.
    function settle(uint256 id) external nonReentrant {
        Auction storage a = auctions[id];
        if (a.lotAmount == 0 || a.settled || block.timestamp < a.revealEnd) revert WrongPhase();
        a.settled = true;

        Bid[] memory b = _sorted(id);
        uint256 left = a.lotAmount;
        uint256 n; // bids that fill
        uint256 clearing;
        for (; n < b.length && left > 0; n++) {
            left -= b[n].qty < left ? b[n].qty : left;
            clearing = b[n].price;
        }
        if (a.lotAmount - left < a.minSold) {
            // not enough demand to clear the seller's minimum: nobody fills, every escrow comes back
            n = 0;
            left = a.lotAmount;
            clearing = 0;
        }

        uint256 proceeds;
        uint256 filled;
        for (uint256 i; i < b.length; i++) {
            uint256 escrow = _cost(b[i].qty, b[i].price);
            if (i < n) {
                uint256 fill = i == n - 1 ? a.lotAmount - left - filled : b[i].qty;
                filled += fill;
                uint256 paid = _cost(uint128(fill), uint128(clearing));
                proceeds += paid;
                _pay(a.lot, b[i].bidder, fill);
                if (escrow > paid) _pay(a.quote, b[i].bidder, escrow - paid);
                emit Filled(id, b[i].bidder, fill, paid);
            } else {
                _pay(a.quote, b[i].bidder, escrow);
            }
        }

        if (proceeds > 0) _pay(a.quote, a.seller, proceeds);
        if (left > 0) _pay(a.lot, a.seller, left);

        uint256 unrevealed = a.commits - a.reveals;
        if (unrevealed > 0) _burn(id, unrevealed * a.bond, "unrevealed bond");

        uint256 sold = a.lotAmount - left;
        if (sold > 0) {
            lastPrint[address(a.lot)][address(a.quote)] =
                Print(uint128(clearing), uint128(sold), uint64(block.timestamp), uint64(id));
        }
        (int256 ref, uint256 refAt) = _ref(a.feed);
        emit Settled(id, clearing, sold, proceeds, ref, refAt);
    }

    /// Collect a payout that settlement couldn't deliver.
    function claim(IERC20 token) external nonReentrant {
        uint256 amount = owed[address(token)][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[address(token)][msg.sender] = 0;
        _push(token, msg.sender, amount);
        emit Claimed(address(token), msg.sender, amount);
    }

    function commitHash(uint256 id, address bidder, uint128 qty, uint128 price, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(id, bidder, qty, price, salt));
    }

    function bids(uint256 id) external view returns (Bid[] memory) {
        return _bids[id];
    }

    // --- internals ---

    function _cost(uint128 qty, uint128 price) internal pure returns (uint256) {
        return (uint256(qty) * price + 1e18 - 1) / 1e18; // round up so escrow always covers payment
    }

    /// Price descending. Ties break on a hash of (id, bidder), so neither reveal order nor address order wins.
    function _sorted(uint256 id) internal view returns (Bid[] memory b) {
        b = _bids[id];
        for (uint256 i = 1; i < b.length; i++) {
            Bid memory x = b[i];
            uint256 j = i;
            while (j > 0 && _before(id, x, b[j - 1])) {
                b[j] = b[j - 1];
                j--;
            }
            b[j] = x;
        }
    }

    function _before(uint256 id, Bid memory x, Bid memory y) internal pure returns (bool) {
        if (x.price != y.price) return x.price > y.price;
        return keccak256(abi.encode(id, x.bidder)) < keccak256(abi.encode(id, y.bidder));
    }

    function _ref(address feed) internal view returns (int256 price, uint256 updatedAt) {
        if (feed == address(0)) return (0, 0);
        try IFeed(feed).latestRoundData() returns (uint80, int256 p, uint256, uint256 t, uint80) {
            return (p, t);
        } catch {
            return (0, 0);
        }
    }

    function _burn(uint256 id, uint256 amount, string memory reason) internal {
        totalBurned += amount;
        wif.burn(amount);
        emit Burned(id, amount, reason);
    }

    /// Pulls exactly `amount`; a fee-on-transfer token would leave escrow short, so it's refused.
    function _pull(IERC20 t, address from, uint256 amount) internal {
        uint256 before = t.balanceOf(address(this));
        (bool ok, bytes memory r) = address(t).call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (!ok || (r.length > 0 && !abi.decode(r, (bool)))) revert TransferFailed();
        if (t.balanceOf(address(this)) - before != amount) revert TransferFailed();
    }

    function _push(IERC20 t, address to, uint256 amount) internal {
        if (!_try(t, to, amount)) revert TransferFailed();
    }

    function _pay(IERC20 t, address to, uint256 amount) internal {
        if (amount == 0 || _try(t, to, amount)) return;
        owed[address(t)][to] += amount;
        emit Owed(address(t), to, amount);
    }

    function _try(IERC20 t, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory r) = address(t).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (r.length == 0 || (r.length == 32 && abi.decode(r, (bool)))); // malformed returns count as failure
    }
}
