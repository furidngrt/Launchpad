// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The parts of a concentrated-liquidity AMM the venue adapter uses.
/// @dev Declared here rather than imported so the protocol compiles against a
/// small, readable surface instead of pulling a whole periphery package in.

interface IAmmFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);

    /// @notice Tick spacing the AMM enforces for a fee tier, or zero when the
    /// tier is not enabled.
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IPositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function factory() external view returns (address);
}

/// @notice The one position call the locker ever makes.
/// @dev `collect` settles fees already owed to a position. It cannot reach the
/// principal, because principal only becomes collectable after a
/// decrease-liquidity call, and no contract in this protocol can make one.
interface IPositionFees {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

/// @notice A pool's own swap entry point, used directly so the protocol needs
/// no router and inherits no router's parameter layout.
interface IAmmPool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function liquidity() external view returns (uint128);
}

interface IWrappedNative {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}
