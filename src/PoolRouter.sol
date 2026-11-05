// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAmmFactory, IAmmPool, IPositionManager, IWrappedNative} from "./interfaces/IAmmV3.sol";
import {PriceMath} from "./libraries/PriceMath.sol";

/// @title PoolRouter
/// @notice Trades a graduated launch against its pool in the native asset, so
/// a launch keeps trading in the same place after it leaves its curve.
///
/// A graduated launch trades in a concentrated-liquidity pool against the
/// wrapped native asset. This router wraps what a buyer sends, swaps it in that
/// pool and delivers the tokens, and on a sale swaps the tokens and pays out
/// native value. It trades directly against the pool, so it depends on no
/// external router, and it quotes by simulating the same swap, so a quote is
/// exactly what the pool would do at that moment.
///
/// The router holds nothing between calls and has no admin. A swap's payment
/// can only be drawn by the pool the router itself is swapping against, during
/// that swap, and a seller's tokens move straight from the seller to the pool,
/// for exactly the amount the pool asked for.
contract PoolRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAmmFactory public immutable ammFactory;
    address public immutable wrappedNative;

    address private transient _activePool;
    address private transient _payer;
    bool private transient _quoting;

    error ZeroAddress();
    error ZeroAmount();
    error AmountTooLarge();
    error Expired();
    error NoPool();
    error UnexpectedCallback();
    error UnexpectedNative();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error QuoteFailed();
    error TransferFailed();

    /// @notice A trade through the router. `amountIn` is native value for a
    /// buy and tokens for a sale; `amountOut` the other side.
    event Swap(
        address indexed token,
        address indexed trader,
        address recipient,
        bool isBuy,
        uint256 amountIn,
        uint256 amountOut,
        uint160 sqrtPriceAfter
    );

    constructor(address positionManager, address wrappedNative_) {
        if (positionManager == address(0) || wrappedNative_ == address(0)) revert ZeroAddress();
        ammFactory = IAmmFactory(IPositionManager(positionManager).factory());
        wrappedNative = wrappedNative_;
    }

    /// @dev Native value arrives only from unwrapping.
    receive() external payable {
        if (msg.sender != wrappedNative) revert UnexpectedNative();
    }

    // --- Trading ---------------------------------------------------------

    /// @notice Buys `token` with the native value sent, delivering at least
    /// `minAmountOut` to `recipient`. Value the pool does not take is refunded.
    function buy(address token, uint24 fee, uint256 minAmountOut, address recipient, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (recipient == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        address pool = _pool(token, fee);

        IWrappedNative(wrappedNative).deposit{value: msg.value}();
        (uint256 spent, uint256 received, uint160 price) =
            _swap(pool, wrappedNative, token, msg.value, recipient, address(0));
        if (received < minAmountOut) revert SlippageExceeded(received, minAmountOut);

        if (spent < msg.value) _payNative(msg.sender, msg.value - spent);
        emit Swap(token, msg.sender, recipient, true, spent, received, price);
        return received;
    }

    /// @notice Sells `amountIn` of `token` for at least `minAmountOut` of
    /// native value, paid to `recipient`. Only the amount the pool takes is
    /// drawn from the seller, so nothing needs refunding.
    function sell(
        address token,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (recipient == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        address pool = _pool(token, fee);

        (uint256 spent, uint256 received, uint160 price) =
            _swap(pool, token, wrappedNative, amountIn, address(this), msg.sender);
        if (received < minAmountOut) revert SlippageExceeded(received, minAmountOut);

        _payNative(recipient, received);
        emit Swap(token, msg.sender, recipient, false, spent, received, price);
        return received;
    }

    // --- Quotes ----------------------------------------------------------

    /// @notice What a buy of `amountIn` native value would deliver now, and
    /// the pool price it would leave behind. Not a view, because it simulates
    /// the swap and unwinds it; call it statically.
    function quoteBuy(address token, uint24 fee, uint256 amountIn)
        external
        nonReentrant
        returns (uint256 amountOut, uint160 sqrtPriceAfter)
    {
        if (amountIn == 0) return (0, 0);
        return _quote(_pool(token, fee), wrappedNative, token, amountIn);
    }

    /// @notice What a sale of `amountIn` tokens would pay now, and the pool
    /// price it would leave behind. Call it statically.
    function quoteSell(address token, uint24 fee, uint256 amountIn)
        external
        nonReentrant
        returns (uint256 amountOut, uint160 sqrtPriceAfter)
    {
        if (amountIn == 0) return (0, 0);
        return _quote(_pool(token, fee), token, wrappedNative, amountIn);
    }

    /// @notice The pool a token trades in against the wrapped native asset, or
    /// the zero address when it has none.
    function poolFor(address token, uint24 fee) external view returns (address) {
        return ammFactory.getPool(token, wrappedNative, fee);
    }

    // --- Swap callbacks --------------------------------------------------

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _settle(amount0Delta, amount1Delta, data);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _settle(amount0Delta, amount1Delta, data);
    }

    // --- Internals -------------------------------------------------------

    function _pool(address token, uint24 fee) private view returns (address pool) {
        if (token == address(0)) revert ZeroAddress();
        pool = ammFactory.getPool(token, wrappedNative, fee);
        if (pool == address(0)) revert NoPool();
    }

    function _swap(address pool, address tokenIn, address tokenOut, uint256 amountIn, address recipient, address payer)
        private
        returns (uint256 spent, uint256 received, uint160 price)
    {
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();
        bool zeroForOne = tokenIn < tokenOut;
        _activePool = pool;
        _payer = payer;
        (int256 amount0, int256 amount1) =
            IAmmPool(pool).swap(recipient, zeroForOne, int256(amountIn), _limit(zeroForOne), abi.encode(tokenIn));
        _activePool = address(0);
        _payer = address(0);

        (int256 paid, int256 got) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
        spent = uint256(paid);
        received = uint256(-got);
        price = _currentPrice(pool);
    }

    function _quote(address pool, address tokenIn, address tokenOut, uint256 amountIn)
        private
        returns (uint256 amountOut, uint160 price)
    {
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();
        bool zeroForOne = tokenIn < tokenOut;
        _activePool = pool;
        _quoting = true;
        try IAmmPool(pool).swap(address(this), zeroForOne, int256(amountIn), _limit(zeroForOne), abi.encode(tokenIn)) {
            revert QuoteFailed();
        } catch (bytes memory reason) {
            _activePool = address(0);
            _quoting = false;
            if (reason.length != 96) revert QuoteFailed();
            (int256 amount0, int256 amount1, uint160 after_) = abi.decode(reason, (int256, int256, uint160));
            amountOut = uint256(-(zeroForOne ? amount1 : amount0));
            price = after_;
        }
    }

    /// @dev Pays the pool this router is swapping against, and only it. While
    /// quoting, reports the swap's outcome by reverting, which unwinds it.
    function _settle(int256 amount0Delta, int256 amount1Delta, bytes calldata data) private {
        if (msg.sender != _activePool) revert UnexpectedCallback();

        if (_quoting) {
            bytes memory result = abi.encode(amount0Delta, amount1Delta, _currentPrice(msg.sender));
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }

        address tokenIn = abi.decode(data, (address));
        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        address payer = _payer;
        if (payer == address(0)) IERC20(tokenIn).safeTransfer(msg.sender, owed);
        else IERC20(tokenIn).safeTransferFrom(payer, msg.sender, owed);
    }

    function _payNative(address to, uint256 amount) private {
        IWrappedNative(wrappedNative).withdraw(amount);
        (bool sent,) = payable(to).call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    function _limit(bool zeroForOne) private pure returns (uint160) {
        return zeroForOne ? PriceMath.MIN_SQRT_PRICE + 1 : PriceMath.MAX_SQRT_PRICE - 1;
    }

    /// @dev Reads only the price, the first word of the pool's state, which
    /// every fork of the AMM lays out the same way.
    function _currentPrice(address pool) private view returns (uint160 price) {
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        if (!ok || data.length < 32) revert NoPool();
        price = abi.decode(data, (uint160));
    }
}
