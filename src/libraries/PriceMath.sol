// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PriceMath
/// @notice Derives the starting price of a graduated pool from the two amounts
/// that seed it, and the widest tick range a pool's spacing allows.
library PriceMath {
    /// @dev Bounds of the concentrated-liquidity tick space. A position spanning
    /// them behaves like a constant-product pool across every reachable price.
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    /// @dev The price range a sqrt-price in Q64.96 can represent.
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    error ZeroAmount();
    error PriceOutOfRange();

    /// @notice sqrt(amount1 / amount0) in Q64.96.
    /// @dev Across a full-range position the two sides of a pool approach
    /// `liquidity / sqrtPrice` and `liquidity * sqrtPrice`, so their ratio
    /// converges on the price. The amounts here are a settled curve's real
    /// reserves, never extreme, which makes that exact enough to seed with.
    /// The Q192 form is used where it fits and a Q128 form covers the rest of
    /// the representable range without overflowing the intermediate quotient.
    function sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();

        if (_fitsQ192(amount0, amount1)) {
            return uint160(Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0)));
        }
        if (!_fitsQ128(amount0, amount1)) revert PriceOutOfRange();

        uint256 sqrtPriceX64 = Math.sqrt(Math.mulDiv(amount1, 1 << 128, amount0));
        if (sqrtPriceX64 > type(uint128).max) revert PriceOutOfRange();
        return uint160(sqrtPriceX64 << 32);
    }

    /// @notice Widest tick pair usable at `tickSpacing`.
    function fullRange(int24 tickSpacing) internal pure returns (int24 tickLower, int24 tickUpper) {
        // forge-lint: disable-next-line(divide-before-multiply)
        tickLower = (MIN_TICK / tickSpacing) * tickSpacing;
        // forge-lint: disable-next-line(divide-before-multiply)
        tickUpper = (MAX_TICK / tickSpacing) * tickSpacing;
    }

    /// @notice True when a sqrt-price is one a pool can be initialized at.
    function isPriceInRange(uint160 price) internal pure returns (bool) {
        return price > MIN_SQRT_PRICE && price < MAX_SQRT_PRICE;
    }

    function _fitsQ192(uint256 amount0, uint256 amount1) private pure returns (bool) {
        if (amount0 > type(uint192).max) return true;
        return amount1 < (amount0 << 64);
    }

    function _fitsQ128(uint256 amount0, uint256 amount1) private pure returns (bool) {
        if (amount0 > type(uint128).max) return true;
        return amount1 < (amount0 << 128);
    }
}
