// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title CurveMath
/// @notice Constant-product pricing for the launch curve, plus the two
/// derivations that fix where a launch graduates and what its pool opens at.
/// @dev Reserves are passed in explicitly so the same formulas price trades in
/// both directions and can be reused by the read-only quoting path. Fees are
/// deliberately not applied here: the curve charges them on the quote leg,
/// outside the product, so the pricing step stays a single invariant.
library CurveMath {
    error InsufficientInput();
    error InsufficientLiquidity();

    /// @notice Output for an exact input against the product `reserveIn * reserveOut`.
    function amountOut(uint256 input, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (input == 0) revert InsufficientInput();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        return Math.mulDiv(input, reserveOut, reserveIn + input);
    }

    /// @notice Same as `amountOut`, returning zero where that would revert.
    /// @dev For callers that treat an unpriceable trade as a state to handle
    /// rather than an error, such as the buyback leg of a fee sweep, which
    /// folds back into the creator's payout when the curve is too thin to
    /// execute against. Routing that case through the reverting form would
    /// take the whole sweep down with it, stranding fees exactly when the
    /// curve cannot support a buyback.
    function quoteOut(uint256 input, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (input == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        return Math.mulDiv(input, reserveOut, reserveIn + input);
    }

    /// @notice Input required for an exact output, rounded up by one so the
    /// product never moves against the curve.
    function amountIn(uint256 output, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (output == 0) revert InsufficientInput();
        if (reserveIn == 0 || reserveOut <= output) revert InsufficientLiquidity();
        return Math.mulDiv(output, reserveIn, reserveOut - output) + 1;
    }

    /// @notice Tokens a launch holds back from the curve for its pool.
    /// @dev Holding `virtualQuote * supply` constant, the curve's real quote
    /// reserve reaches `graduationTarget` exactly when its token balance falls
    /// to this figure. Reserving it therefore does not move where a launch
    /// graduates; it only stops the curve selling through that point, which is
    /// what makes the pool deterministic. Expressing graduation against the
    /// token side also gives a hard stop: a large buy can sail past a quote
    /// floor, but it cannot cross a reserve the curve refuses to sell.
    function reserveFloor(uint256 supply, uint256 virtualQuote, uint256 graduationTarget)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(supply, virtualQuote, virtualQuote + graduationTarget);
    }

    /// @notice Share of the reserved tokens that enters the pool.
    /// @dev The virtual reserve is not real money, so it cannot be paid into
    /// the pool. Seeding the whole reserved balance against the real quote
    /// collected would open the pool below the price the curve ended at. This
    /// scales the token side by the same ratio, which preserves that price;
    /// the remainder is locked forever and never enters circulation.
    function listingTokens(uint256 reservedTokens, uint256 settledQuote, uint256 virtualQuote)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(reservedTokens, settledQuote, settledQuote + virtualQuote);
    }
}
