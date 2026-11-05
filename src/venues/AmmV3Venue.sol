// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAmmFactory, IAmmPool, IPositionManager, IWrappedNative} from "../interfaces/IAmmV3.sol";
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
/// The hazard this adapter exists to handle is that the pool may already
/// exist. A launch's token address is public from the moment the launch is
/// created, so anyone can create its pool first and initialize it at whatever
/// price they like, with or without liquidity of their own. Minting into that
/// pool as found would deposit the curve's reserves at the attacker's price,
/// and the attacker would then trade the difference out of a position that can
/// never be withdrawn.
///
/// So the adapter never mints at a price it did not choose. It computes the
/// price the curve finished at, and if the pool is anywhere else it trades the
/// pool back to exactly that price first, using the reserves it was given.
/// Against an empty pool that costs nothing, because a swap through zero
/// liquidity moves the price without exchanging anything. Against an
/// attacker's liquidity it is profitable for the launch, because pushing a
/// mispriced pool back to its fair price buys from it below value or sells to
/// it above value, and the gain goes into the locked position. Only once the
/// price is exact, in the same transaction, does it mint.
///
/// A launch quoted in the native asset is listed against its wrapped form,
/// since that is what a pool can hold. The wrapping and unwrapping happen here,
/// so the rest of the protocol keeps treating native value as native.
///
/// This adapter is never the owner of a position, holds no balance between
/// calls, and has no admin.
contract AmmV3Venue is ILiquidityVenue, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant DEADLINE_WINDOW = 300;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidSeed();
    error PriceOutOfRange();
    error AmountTooLarge();
    error FeeTierMismatch(uint24 fee, int24 expected, int24 configured);
    error NativeValueMismatch(uint256 sent, uint256 expected);
    error PriceNotRestored(uint160 actual, uint160 target);
    error NothingMinted();
    error NoPool();
    error UnexpectedCallback();
    error UnexpectedNative();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error TransferFailed();

    event PoolPriceRestored(address indexed pool, uint160 from, uint160 to);

    /// @notice Registry that records liquidity positions.
    address public immutable positionRegistry;

    /// @notice The AMM's pool registry.
    IAmmFactory public immutable ammFactory;

    /// @notice Wrapped form of the native asset.
    address public immutable wrappedNative;

    /// @dev The one pool allowed to call back, and only while a swap this
    /// adapter started is in progress. Held in transient storage, so it can
    /// never outlive the transaction that set it.
    address private transient _activePool;

    constructor(IPositionManager positionManager_, address wrappedNative_) {
        if (address(positionManager_) == address(0) || wrappedNative_ == address(0)) revert ZeroAddress();

        positionRegistry = address(positionManager_);
        ammFactory = IAmmFactory(positionManager_.factory());
        wrappedNative = wrappedNative_;
        if (address(ammFactory) == address(0)) revert ZeroAddress();
    }

    // --- Listing ---------------------------------------------------------

    /// @notice Creates or repairs the pool, seeds it with one full-range
    /// position at the price the two amounts imply, and mints that position to
    /// `lockTo`.
    /// @dev The caller sends the launch token by approval and the quote asset
    /// either as value, for a native launch, or by transfer beforehand. Whatever
    /// the mint does not take is returned to the caller in the form it arrived
    /// in, so the caller can account for it rather than lose it here.
    function list(Listing calldata listing) external payable nonReentrant returns (uint256 positionId, address pool) {
        if (listing.lockTo == address(0)) revert ZeroAddress();
        if (listing.tokenAmount == 0 || listing.quoteAmount == 0) revert ZeroAmount();

        bool native = listing.quote == address(0);
        address quoteToken = native ? wrappedNative : listing.quote;
        if (native) {
            if (msg.value != listing.quoteAmount) revert NativeValueMismatch(msg.value, listing.quoteAmount);
            IWrappedNative(wrappedNative).deposit{value: msg.value}();
        } else if (msg.value != 0) {
            revert NativeValueMismatch(msg.value, 0);
        }
        IERC20(listing.token).safeTransferFrom(msg.sender, address(this), listing.tokenAmount);

        (address token0, address token1, uint256 amount0, uint256 amount1) =
            _order(listing.token, quoteToken, listing.tokenAmount, listing.quoteAmount);

        uint160 target = PriceMath.sqrtPriceX96(amount0, amount1);
        if (!PriceMath.isPriceInRange(target)) revert PriceOutOfRange();

        // Creates the pool at the target price if it does not exist. If it
        // does, this leaves its price alone, which is why the next step exists.
        pool = IPositionManager(positionRegistry).createAndInitializePoolIfNecessary(
            token0, token1, listing.fee, target
        );
        _restorePrice(pool, token0, token1, listing.fee, target);

        positionId = _mintFullRange(token0, token1, listing.fee, listing.tickSpacing, listing.lockTo);

        _returnAll(listing.token, msg.sender, false);
        _returnAll(quoteToken, msg.sender, native);
    }

    /// @notice Reverts unless a seed of these amounts could be listed.
    /// @dev Called before the irreversible step that drains a curve, so a
    /// launch can never hand over its reserves for a pool that cannot open.
    function checkSeed(
        address token,
        address quote,
        uint24 fee,
        int24 tickSpacing,
        uint256 tokenAmount,
        uint256 quoteAmount
    ) external view {
        if (token == address(0) || tokenAmount == 0 || quoteAmount == 0) revert InvalidSeed();
        checkFeeTier(fee, tickSpacing);
        // Pool balance changes are carried as signed 128-bit values, so the
        // signed maximum is the real bound even where an interface accepts an
        // unsigned one.
        if (tokenAmount > uint256(uint128(type(int128).max))) revert AmountTooLarge();
        if (quoteAmount > uint256(uint128(type(int128).max))) revert AmountTooLarge();

        address quoteToken = quote == address(0) ? wrappedNative : quote;
        (,, uint256 amount0, uint256 amount1) = _order(token, quoteToken, tokenAmount, quoteAmount);
        if (!PriceMath.isPriceInRange(PriceMath.sqrtPriceX96(amount0, amount1))) revert PriceOutOfRange();
    }

    /// @notice Reverts unless `fee` is a tier the AMM has enabled with exactly
    /// `tickSpacing`.
    /// @dev The AMM fixes the spacing per fee tier. A configuration that pairs
    /// a tier with any other spacing would compute range bounds the pool
    /// rejects, so every graduation on it would fail. Checked when a
    /// configuration is added, so the mistake is caught before any launch can
    /// be created against it.
    function checkFeeTier(uint24 fee, int24 tickSpacing) public view {
        int24 expected = ammFactory.feeAmountTickSpacing(fee);
        if (expected == 0 || expected != tickSpacing) revert FeeTierMismatch(fee, expected, tickSpacing);
    }

    // --- Fee conversion --------------------------------------------------

    /// @notice Sells `amountIn` of `tokenIn` for at least `minAmountOut`,
    /// trading directly against the pool.
    /// @dev Used only to convert accrued fees. The caller sets the minimum, so
    /// this adapter never decides what price is acceptable. Any input the pool
    /// does not take comes back to the caller.
    function swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minAmountOut, address to)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        address pool = ammFactory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert NoPool();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        bool zeroForOne = tokenIn < tokenOut;
        (address token0, address token1) = zeroForOne ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        uint160 limit = zeroForOne ? PriceMath.MIN_SQRT_PRICE + 1 : PriceMath.MAX_SQRT_PRICE - 1;

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        _swap(pool, token0, token1, fee, zeroForOne, amountIn, limit);
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        IERC20(tokenOut).safeTransfer(to, amountOut);
        _returnAll(tokenIn, msg.sender, false);
    }

    /// @notice The pool a launch trades in, or the zero address before listing.
    function poolFor(address token, address quote, uint24 fee) external view returns (address) {
        address quoteToken = quote == address(0) ? wrappedNative : quote;
        return ammFactory.getPool(token, quoteToken, fee);
    }

    // --- Swap callbacks --------------------------------------------------

    /// @notice Pays a pool for a swap this adapter started.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _paySwap(amount0Delta, amount1Delta, data);
    }

    /// @notice The same callback under the name some forks of the AMM use.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _paySwap(amount0Delta, amount1Delta, data);
    }

    // --- Internals -------------------------------------------------------

    /// @dev Moves the pool to exactly `target` if it is anywhere else.
    function _restorePrice(address pool, address token0, address token1, uint24 fee, uint160 target) private {
        uint160 current = _currentPrice(pool);
        if (current == target) return;

        // A price above target means token0 is overvalued: sell token0 into the
        // pool to bring it down. Below target, sell token1.
        bool zeroForOne = current > target;
        uint256 available = IERC20(zeroForOne ? token0 : token1).balanceOf(address(this));
        if (available == 0) revert PriceNotRestored(current, target);

        _swap(pool, token0, token1, fee, zeroForOne, available, target);

        uint160 restored = _currentPrice(pool);
        // If the reserves ran out before the pool reached the target, minting
        // now would still be at a price someone else chose. Refuse, and leave
        // the launch settled: listing stays retryable once the pool is fixed.
        if (restored != target) revert PriceNotRestored(restored, target);
        emit PoolPriceRestored(pool, current, target);
    }

    function _mintFullRange(address token0, address token1, uint24 fee, int24 tickSpacing, address recipient)
        private
        returns (uint256 positionId)
    {
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        (int24 tickLower, int24 tickUpper) = PriceMath.fullRange(tickSpacing);

        IERC20(token0).forceApprove(positionRegistry, balance0);
        IERC20(token1).forceApprove(positionRegistry, balance1);

        uint128 liquidity;
        (positionId, liquidity,,) = IPositionManager(positionRegistry).mint(
            IPositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: balance0,
                amount1Desired: balance1,
                // The pool's price was set to the target in this same
                // transaction, immediately above, and nothing can run between
                // that and this. A minimum here would protect against nothing.
                amount0Min: 0,
                amount1Min: 0,
                recipient: recipient,
                deadline: block.timestamp + DEADLINE_WINDOW
            })
        );
        if (liquidity == 0) revert NothingMinted();

        IERC20(token0).forceApprove(positionRegistry, 0);
        IERC20(token1).forceApprove(positionRegistry, 0);
    }

    function _swap(
        address pool,
        address token0,
        address token1,
        uint24 fee,
        bool zeroForOne,
        uint256 amountIn,
        uint160 limit
    ) private {
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();
        _activePool = pool;
        IAmmPool(pool).swap(address(this), zeroForOne, int256(amountIn), limit, abi.encode(token0, token1, fee));
        _activePool = address(0);
    }

    /// @dev Only the pool this adapter is swapping against, during that swap,
    /// can collect payment, and the pool is confirmed against the AMM's own
    /// registry as well, so no other contract can draw on balances held here.
    function _paySwap(int256 amount0Delta, int256 amount1Delta, bytes calldata data) private {
        if (msg.sender != _activePool) revert UnexpectedCallback();
        (address token0, address token1, uint24 fee) = abi.decode(data, (address, address, uint24));
        if (ammFactory.getPool(token0, token1, fee) != msg.sender) revert UnexpectedCallback();

        if (amount0Delta > 0) IERC20(token0).safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).safeTransfer(msg.sender, uint256(amount1Delta));
    }

    /// @dev Reads only the first word of the pool's state, its price. Forks of
    /// the AMM disagree on the width of later fields, so decoding the whole
    /// tuple against one layout would fail against another.
    function _currentPrice(address pool) private view returns (uint160 price) {
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        if (!ok || data.length < 32) revert NoPool();
        price = abi.decode(data, (uint160));
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

    function _returnAll(address asset, address to, bool unwrap) private {
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance == 0) return;
        if (unwrap) {
            IWrappedNative(asset).withdraw(balance);
            (bool sent,) = payable(to).call{value: balance}("");
            if (!sent) revert TransferFailed();
            return;
        }
        IERC20(asset).safeTransfer(to, balance);
    }

    /// @notice Accepts native value only from unwrapping.
    receive() external payable {
        if (msg.sender != wrappedNative) revert UnexpectedNative();
    }
}
