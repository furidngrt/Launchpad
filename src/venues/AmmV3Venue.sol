// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAmmFactory, IPositionManager, ISwapRouter, IWrappedNative} from "../interfaces/IAmmV3.sol";
import {ILiquidityVenue} from "../interfaces/ILaunchpad.sol";
import {PriceMath} from "../libraries/PriceMath.sol";

/// @title AmmV3Venue
/// @notice Lists a graduated launch on a concentrated-liquidity AMM.
///
/// The protocol's core contracts never name an AMM. They call this adapter,
/// which is the only place that knows how one works. Supporting a different
/// AMM therefore means deploying another adapter, not changing the launchpad,
/// and because every launch records the adapter it was created with, doing so
/// leaves existing launches exactly where they are.
///
/// A launch quoted in the native asset is listed against its wrapped form,
/// since that is what a pool can hold. The wrapping happens here, so the rest
/// of the protocol can keep treating native value as native.
///
/// The position is minted straight to the locker. This adapter is never its
/// owner, holds no balance between calls, and has no admin.
contract AmmV3Venue is ILiquidityVenue {
    using SafeERC20 for IERC20;

    /// @dev One full-range position spanning the whole tick space behaves like
    /// a constant-product pool, which is what the curve hands over.
    uint256 private constant DEADLINE_WINDOW = 300;

    error ZeroAddress();
    error InvalidSeed();
    error PriceOutOfRange();
    error AmountTooLarge();
    error NativeValueMismatch(uint256 sent, uint256 expected);

    /// @notice Registry that records liquidity positions.
    address public immutable positionRegistry;

    /// @notice The AMM's pool registry.
    IAmmFactory public immutable ammFactory;

    /// @notice Router used to convert fees.
    ISwapRouter public immutable swapRouter;

    /// @notice Wrapped form of the native asset.
    address public immutable wrappedNative;

    constructor(IPositionManager positionManager_, ISwapRouter swapRouter_, address wrappedNative_) {
        if (address(positionManager_) == address(0) || address(swapRouter_) == address(0)) revert ZeroAddress();
        if (wrappedNative_ == address(0)) revert ZeroAddress();

        positionRegistry = address(positionManager_);
        ammFactory = IAmmFactory(positionManager_.factory());
        swapRouter = swapRouter_;
        wrappedNative = wrappedNative_;
    }

    /// @notice Creates the pool at the price the two amounts imply, seeds it
    /// with one full-range position, and mints that position to `lockTo`.
    /// @dev The caller sends the launch token by approval and the quote asset
    /// either as value, for a native launch, or by transfer beforehand. Any
    /// rounding dust the mint does not take is returned to the caller rather
    /// than left here.
    function list(Listing calldata listing) external payable returns (uint256 positionId, address pool) {
        if (listing.lockTo == address(0)) revert ZeroAddress();

        address quoteToken = listing.quote == address(0) ? wrappedNative : listing.quote;
        if (listing.quote == address(0)) {
            if (msg.value != listing.quoteAmount) revert NativeValueMismatch(msg.value, listing.quoteAmount);
            IWrappedNative(wrappedNative).deposit{value: msg.value}();
        } else if (msg.value != 0) {
            revert NativeValueMismatch(msg.value, 0);
        }

        IERC20(listing.token).safeTransferFrom(msg.sender, address(this), listing.tokenAmount);

        (address token0, address token1, uint256 amount0, uint256 amount1) =
            _order(listing.token, quoteToken, listing.tokenAmount, listing.quoteAmount);

        uint160 sqrtPriceX96 = PriceMath.sqrtPriceX96(amount0, amount1);
        if (!PriceMath.isPriceInRange(sqrtPriceX96)) revert PriceOutOfRange();

        pool = IPositionManager(positionRegistry).createAndInitializePoolIfNecessary(
            token0, token1, listing.fee, sqrtPriceX96
        );

        (int24 tickLower, int24 tickUpper) = PriceMath.fullRange(listing.tickSpacing);
        IERC20(token0).forceApprove(positionRegistry, amount0);
        IERC20(token1).forceApprove(positionRegistry, amount1);

        (positionId,,,) = IPositionManager(positionRegistry).mint(
            IPositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: listing.fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                // The mint price is the one derived above, so there is nothing
                // for a slippage bound to protect against here: this pool did
                // not exist a moment ago and no third party can be inside it.
                amount0Min: 0,
                amount1Min: 0,
                recipient: listing.lockTo,
                deadline: block.timestamp + DEADLINE_WINDOW
            })
        );

        IERC20(token0).forceApprove(positionRegistry, 0);
        IERC20(token1).forceApprove(positionRegistry, 0);

        _returnDust(listing.token, msg.sender);
        _returnDust(quoteToken, msg.sender);
    }

    /// @notice Reverts unless a seed of these amounts could be listed.
    /// @dev Called before the irreversible step that drains a curve, so a
    /// launch can never hand over its reserves for a pool that cannot open.
    function checkSeed(address token, address quote, int24 tickSpacing, uint256 tokenAmount, uint256 quoteAmount)
        external
        view
    {
        if (token == address(0) || tokenAmount == 0 || quoteAmount == 0) revert InvalidSeed();
        if (tickSpacing <= 0) revert InvalidSeed();
        // Pool balance changes are carried as signed 128-bit values, so the
        // signed maximum is the real bound even where an interface accepts an
        // unsigned one.
        if (tokenAmount > uint256(uint128(type(int128).max))) revert AmountTooLarge();
        if (quoteAmount > uint256(uint128(type(int128).max))) revert AmountTooLarge();

        address quoteToken = quote == address(0) ? wrappedNative : quote;
        (,, uint256 amount0, uint256 amount1) = _order(token, quoteToken, tokenAmount, quoteAmount);
        if (!PriceMath.isPriceInRange(PriceMath.sqrtPriceX96(amount0, amount1))) revert PriceOutOfRange();
    }

    /// @notice Sells `amountIn` of `tokenIn` for at least `minAmountOut`.
    /// @dev Used only to convert accrued fees. The caller sets the minimum, so
    /// this adapter never decides what price is acceptable.
    function swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut)
    {
        if (to == address(0)) revert ZeroAddress();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);

        amountOut = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: to,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenIn).forceApprove(address(swapRouter), 0);
        _returnDust(tokenIn, msg.sender);
    }

    /// @notice The pool a launch trades in, or the zero address before listing.
    function poolFor(address token, address quote, uint24 fee) external view returns (address) {
        address quoteToken = quote == address(0) ? wrappedNative : quote;
        return ammFactory.getPool(token, quoteToken, fee);
    }

    /// @dev Pools order their two assets by address, and the seed price depends
    /// on that order, so it is resolved in one place.
    function _order(address token, address quoteToken, uint256 tokenAmount, uint256 quoteAmount)
        private
        pure
        returns (address token0, address token1, uint256 amount0, uint256 amount1)
    {
        if (token < quoteToken) return (token, quoteToken, tokenAmount, quoteAmount);
        return (quoteToken, token, quoteAmount, tokenAmount);
    }

    function _returnDust(address asset, address to) private {
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance != 0) IERC20(asset).safeTransfer(to, balance);
    }

    /// @notice Accepts native value for a wrap.
    receive() external payable {}
}
