// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITutupPrints {
    function lastPrint(address lot, address quote)
        external
        view
        returns (uint128 price, uint128 sold, uint64 at, uint64 auctionId);
}

/// @title TutupFeed — Tutup's weekend prints behind Chainlink's AggregatorV3Interface.
/// @notice One feed per lot/quote pair. Any protocol that already reads a Chainlink feed can read the last
/// sealed-bid clearing price the same way: latestRoundData() returns the price scaled to `decimals()`,
/// with updatedAt = the settlement time and roundId = the auction id. It answers only what an auction
/// actually cleared; with no sale yet it reverts, so a consumer can't mistake "no price" for zero.
contract TutupFeed {
    ITutupPrints public immutable tutup;
    address public immutable lot;
    address public immutable quote;
    uint8 public immutable quoteDecimals;
    uint8 public constant decimals = 8;
    uint256 public constant version = 1;
    string public description;

    error NoPrint();

    constructor(ITutupPrints _tutup, address _lot, address _quote, uint8 _quoteDecimals, string memory _description) {
        tutup = _tutup;
        lot = _lot;
        quote = _quote;
        quoteDecimals = _quoteDecimals;
        description = _description;
    }

    /// Price of one whole lot token in quote units, 8 decimals.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint128 price,, uint64 at, uint64 auctionId) = tutup.lastPrint(lot, quote);
        if (at == 0) revert NoPrint();
        uint256 scaled = quoteDecimals >= decimals
            ? uint256(price) / 10 ** (quoteDecimals - decimals)
            : uint256(price) * 10 ** (decimals - quoteDecimals);
        return (uint80(auctionId), int256(scaled), at, at, uint80(auctionId));
    }

    function latestAnswer() external view returns (int256 answer) {
        (, answer,,,) = this.latestRoundData();
    }
}
