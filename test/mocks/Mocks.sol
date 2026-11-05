// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAmmFactory, IPositionManager, IPositionFees, ISwapRouter} from "../../src/interfaces/IAmmV3.sol";

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

/// @notice Records which pool address belongs to a pair.
contract MockAmmFactory is IAmmFactory {
    mapping(bytes32 => address) private _pools;

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return _pools[_key(tokenA, tokenB, fee)];
    }

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        _pools[_key(tokenA, tokenB, fee)] = pool;
    }

    function _key(address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
        (address a, address b) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(a, b, fee));
    }
}

/// @notice Stands in for the AMM's position manager. It takes both sides of a
/// seed, hands the position to the recipient, and can be told to owe fees so
/// the post-graduation split can be exercised.
contract MockPositionManager is IPositionManager, IPositionFees {
    using SafeERC20 for IERC20;

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
    mapping(bytes32 => uint160) public initializedAt;

    constructor(address factory_) {
        factory = factory_;
    }

    function setMintReverts(bool value) external {
        mintReverts = value;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool)
    {
        bytes32 key = keccak256(abi.encode(token0, token1, fee));
        if (initializedAt[key] == 0) initializedAt[key] = sqrtPriceX96;
        pool = address(uint160(uint256(key)));
        MockAmmFactory(factory).setPool(token0, token1, fee, pool);
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(!mintReverts, "mint reverts");

        // Leave a little of each side untaken, the way a real mint rounds, so
        // the dust path is exercised.
        amount0 = params.amount0Desired - (params.amount0Desired % 7);
        amount1 = params.amount1Desired - (params.amount1Desired % 7);

        IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);

        liquidity = uint128(Math.sqrt(amount0 * amount1));
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

    function positions(uint256 tokenId)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        Info memory position = info[tokenId];
        return (
            0,
            address(0),
            position.token0,
            position.token1,
            position.fee,
            position.tickLower,
            position.tickUpper,
            position.liquidity,
            0,
            0,
            position.owed0,
            position.owed1
        );
    }
}

/// @notice Swaps at a rate the test sets, paying out of its own balance and
/// honouring the caller's minimum.
contract MockSwapRouter is ISwapRouter {
    using SafeERC20 for IERC20;

    /// @dev Output per unit of input, scaled by 1e18.
    mapping(address => mapping(address => uint256)) public rate;
    bool public swapReverts;

    function setRate(address tokenIn, address tokenOut, uint256 rate_) external {
        rate[tokenIn][tokenOut] = rate_;
    }

    function setSwapReverts(bool value) external {
        swapReverts = value;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(!swapReverts, "swap reverts");
        uint256 configured = rate[params.tokenIn][params.tokenOut];
        require(configured != 0, "no rate");

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        amountOut = (params.amountIn * configured) / 1e18;
        require(amountOut >= params.amountOutMinimum, "Too little received");
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}

/// @notice A recipient that refuses native value, used to show that one
/// recipient failing cannot block anybody else.
contract RejectingRecipient {
    receive() external payable {
        revert("no thanks");
    }
}
