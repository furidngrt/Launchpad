// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAmmFactory, IPositionManager, IPositionFees} from "../../src/interfaces/IAmmV3.sol";

/// @notice Plain mintable ERC-20 standing in for a quote asset.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice An ERC-20 that keeps a share of every transfer, used to check that
/// the protocol credits what arrives rather than what was asked for.
contract MockFeeOnTransferToken is ERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) ERC20("Fee On Transfer", "FOT") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(this), fee);
    }
}

/// @notice Minimal wrapped-native token.
contract MockWrappedNative is ERC20 {
    constructor() ERC20("Wrapped Native", "WNATIVE") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        require(sent, "withdraw failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

interface ISwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice A concentrated-liquidity pool reduced to a single full range.
/// @dev Faithful to what the venue depends on: anyone may initialize it once at
/// any price; a swap through zero liquidity moves the price to the limit
/// without exchanging anything; with liquidity, the price moves along the
/// constant-product curve `x = L / sqrtP`, `y = L * sqrtP`; output is sent
/// before the callback and payment is checked after it.
contract MockPool {
    using SafeERC20 for IERC20;

    uint256 private constant Q96 = 1 << 96;

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    address public immutable manager;

    uint160 public sqrtPriceX96;
    uint128 public liquidity;
    bool public swapReverts;

    constructor(address token0_, address token1_, uint24 fee_, address manager_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        manager = manager_;
    }

    function initialize(uint160 price) external {
        require(sqrtPriceX96 == 0, "already initialized");
        sqrtPriceX96 = price;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, true);
    }

    function setSwapReverts(bool value) external {
        swapReverts = value;
    }

    /// @dev Only the position manager adds liquidity, after taking the tokens.
    function addLiquidity(uint128 amount) external {
        require(msg.sender == manager, "not manager");
        liquidity += amount;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(!swapReverts, "swap reverts");
        require(sqrtPriceX96 != 0, "not initialized");
        require(amountSpecified > 0, "exact input only");
        uint256 amountIn = uint256(amountSpecified);
        uint160 price = sqrtPriceX96;
        uint256 L = liquidity;

        uint256 used;
        uint256 out;
        uint160 next;

        if (zeroForOne) {
            require(limit < price, "bad limit");
            if (L == 0) {
                next = limit;
            } else {
                next = uint160(Math.mulDiv(L * Q96, price, L * Q96 + amountIn * price));
                // As in the real pool, an exact-input swap that does not reach
                // its limit consumes the whole input; rounding favours the pool.
                used = amountIn;
                if (next < limit) {
                    next = limit;
                    used = Math.mulDiv(L, Q96, next) - Math.mulDiv(L, Q96, price);
                    if (used > amountIn) used = amountIn;
                }
                out = Math.mulDiv(L, price - next, Q96);
            }
            amount0 = int256(used);
            amount1 = -int256(out);
        } else {
            require(limit > price, "bad limit");
            if (L == 0) {
                next = limit;
            } else {
                next = uint160(uint256(price) + Math.mulDiv(amountIn, Q96, L));
                used = amountIn;
                if (next > limit) {
                    next = limit;
                    used = Math.mulDiv(L, next - price, Q96);
                    if (used > amountIn) used = amountIn;
                }
                out = Math.mulDiv(L, Q96, price) - Math.mulDiv(L, Q96, next);
            }
            amount0 = -int256(out);
            amount1 = int256(used);
        }

        sqrtPriceX96 = next;

        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;
        if (out != 0) IERC20(tokenOut).safeTransfer(recipient, out);

        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        ISwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tokenIn).balanceOf(address(this)) >= before + used, "underpaid");
    }
}

/// @notice Registry of pools and the tick spacing each fee tier enforces.
contract MockAmmFactory is IAmmFactory {
    mapping(bytes32 => address) private _pools;
    mapping(uint24 => int24) public feeAmountTickSpacing;

    constructor() {
        feeAmountTickSpacing[100] = 1;
        feeAmountTickSpacing[500] = 10;
        feeAmountTickSpacing[3000] = 60;
        feeAmountTickSpacing[10000] = 200;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return _pools[_key(tokenA, tokenB, fee)];
    }

    /// @dev Open to anyone, exactly like the real thing. That openness is the
    /// hazard the venue has to handle.
    function createPool(address tokenA, address tokenB, uint24 fee) public returns (address pool) {
        require(feeAmountTickSpacing[fee] != 0, "fee not enabled");
        bytes32 key = _key(tokenA, tokenB, fee);
        require(_pools[key] == address(0), "exists");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pool = address(new MockPool(token0, token1, fee, manager));
        _pools[key] = pool;
    }

    address public manager;

    function setManager(address manager_) external {
        require(manager == address(0), "set");
        manager = manager_;
    }

    function _key(address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
        (address a, address b) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(a, b, fee));
    }
}

/// @notice Stands in for the AMM's position manager over `MockPool`. Mints
/// full-range liquidity at the pool's current price, and can be told to owe
/// fees so the post-graduation split can be exercised.
contract MockPositionManager is IPositionManager, IPositionFees {
    using SafeERC20 for IERC20;

    uint256 private constant Q96 = 1 << 96;

    struct Info {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
    }

    address public immutable override factory;

    uint256 public nextTokenId = 1;
    bool public mintReverts;

    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => Info) public info;

    constructor(address factory_) {
        factory = factory_;
        MockAmmFactory(factory_).setManager(address(this));
    }

    function setMintReverts(bool value) external {
        mintReverts = value;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool)
    {
        pool = MockAmmFactory(factory).getPool(token0, token1, fee);
        if (pool == address(0)) pool = MockAmmFactory(factory).createPool(token0, token1, fee);
        // Like the real manager: an existing, initialized pool keeps its price.
        if (MockPool(pool).sqrtPriceX96() == 0) MockPool(pool).initialize(sqrtPriceX96);
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(!mintReverts, "mint reverts");
        address pool = MockAmmFactory(factory).getPool(params.token0, params.token1, params.fee);
        require(pool != address(0), "no pool");
        uint160 price = MockPool(pool).sqrtPriceX96();
        require(price != 0, "not initialized");

        // Full-range liquidity is limited by whichever side is scarcer at the
        // current price; the other side's excess is left with the caller.
        uint256 fromAmount0 = Math.mulDiv(params.amount0Desired, price, Q96);
        uint256 fromAmount1 = Math.mulDiv(params.amount1Desired, Q96, price);
        uint256 L = Math.min(fromAmount0, fromAmount1);
        require(L > 0 && L <= type(uint128).max, "no liquidity");

        amount0 = Math.mulDiv(L, Q96, price);
        amount1 = Math.mulDiv(L, price, Q96);
        if (amount0 > params.amount0Desired) amount0 = params.amount0Desired;
        if (amount1 > params.amount1Desired) amount1 = params.amount1Desired;
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "slippage");

        IERC20(params.token0).safeTransferFrom(msg.sender, pool, amount0);
        IERC20(params.token1).safeTransferFrom(msg.sender, pool, amount1);
        liquidity = uint128(L);
        MockPool(pool).addLiquidity(liquidity);

        tokenId = nextTokenId++;
        ownerOf[tokenId] = params.recipient;
        info[tokenId] = Info({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            owed0: 0,
            owed1: 0
        });
    }

    /// @notice Test hook: makes the position owe fees, funded by the caller.
    function accrueFees(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        Info storage position = info[tokenId];
        if (amount0 != 0) IERC20(position.token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 != 0) IERC20(position.token1).safeTransferFrom(msg.sender, address(this), amount1);
        position.owed0 += uint128(amount0);
        position.owed1 += uint128(amount1);
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        require(msg.sender == ownerOf[params.tokenId], "not owner");
        Info storage position = info[params.tokenId];

        amount0 = Math.min(position.owed0, params.amount0Max);
        amount1 = Math.min(position.owed1, params.amount1Max);
        position.owed0 -= uint128(amount0);
        position.owed1 -= uint128(amount1);

        if (amount0 != 0) IERC20(position.token0).safeTransfer(params.recipient, amount0);
        if (amount1 != 0) IERC20(position.token1).safeTransfer(params.recipient, amount1);
    }
}

/// @notice A recipient that refuses native value, used to show that one
/// recipient failing cannot block anybody else.
contract RejectingRecipient {
    receive() external payable {
        revert("no thanks");
    }

    /// @notice Lets the test act as this contract to claim elsewhere.
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory result) = target.call(data);
        require(ok, "call failed");
        return result;
    }
}
