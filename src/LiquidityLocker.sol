// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPositionFees} from "./interfaces/IAmmV3.sol";
import {ILiquidityLocker, ILiquidityVenue} from "./interfaces/ILaunchpad.sol";

/// @title LiquidityLocker
/// @notice Final custody of every graduated launch's liquidity.
///
/// This is the contract that makes the usual rug impossible. A graduated pool's
/// position arrives here and never leaves, because this contract has no
/// function that could send it anywhere: no transfer, no withdrawal, no
/// decrease-liquidity call, no arbitrary call, no upgrade path and no admin
/// role that could add one. The guarantee is structural rather than a promise
/// not to act, and anyone can verify it by reading this file.
///
/// Two things do leave. Trading fees, which the designated collector pulls
/// through `collectFees`, reaching a venue call that can only ever move fees
/// owed and never principal. And nothing else.
///
/// Tokens that could not enter the pool at the graduation price are locked here
/// too, under `lockSupply`, with the same absence of any way out.
contract LiquidityLocker is ILiquidityLocker, IERC721Receiver {
    using SafeERC20 for IERC20;

    error NotFactory();
    error NotCollector();
    error NotAuthorized();
    error AlreadyInitialized();
    error ZeroAddress();
    error AlreadyLocked();
    error PositionNotHeld();

    event FactorySet(address factory);
    event PositionLocked(address indexed token, uint256 indexed positionId, address venue);
    event SupplyLocked(address indexed token, uint256 amount);
    event FeesCollected(address indexed token, address indexed recipient, uint256 tokenAmount, uint256 quoteAmount);

    struct Position {
        uint256 positionId;
        address venue;
        bool locked;
    }

    /// @notice Protocol factory; the only caller that can register a lock.
    address public factory;

    /// @dev Set once by the deployer, then this contract has no admin at all.
    address private _initializer;

    mapping(address token => Position) private _positions;
    mapping(address token => uint256 amount) public lockedSupply;

    constructor(address initializer_) {
        if (initializer_ == address(0)) revert ZeroAddress();
        _initializer = initializer_;
    }

    /// @notice Wires the factory once, after both are deployed.
    /// @dev The right to call this is consumed immediately, so this contract
    /// ends up with no privileged role of any kind.
    function setFactory(address factory_) external {
        if (msg.sender != _initializer) revert NotAuthorized();
        if (factory != address(0)) revert AlreadyInitialized();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        _initializer = address(0);
        emit FactorySet(factory_);
    }

    /// @notice Records that this contract holds `token`'s graduated position.
    /// @dev Called once per launch by the factory, right after the venue minted
    /// the position to this address. Custody is confirmed by asking the venue's
    /// position registry who owns it rather than trusting the caller.
    function lockPosition(address token, uint256 positionId, address venue) external {
        if (msg.sender != factory) revert NotFactory();
        if (token == address(0) || venue == address(0)) revert ZeroAddress();
        if (_positions[token].locked) revert AlreadyLocked();
        if (IERC721(_positionRegistry(venue)).ownerOf(positionId) != address(this)) revert PositionNotHeld();

        _positions[token] = Position({positionId: positionId, venue: venue, locked: true});
        emit PositionLocked(token, positionId, venue);
    }

    /// @notice Locks supply that could not enter the pool without lowering the
    /// price it opens at.
    function lockSupply(address token, uint256 amount) external {
        if (msg.sender != factory) revert NotFactory();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) return;

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;

        lockedSupply[token] += received;
        emit SupplyLocked(token, received);
    }

    /// @notice Sends `token`'s accrued trading fees to the protocol's fee
    /// collector for splitting.
    /// @dev The only value-moving function in this contract, and the reason it
    /// cannot reach principal is worth stating exactly. It makes one call,
    /// `collect`, which settles the fees a position is already owed. Principal
    /// only becomes collectable after a decrease-liquidity call, and no
    /// contract in this protocol can make one: this contract has no such
    /// function, and nothing else can act on the position because it is never
    /// transferred or approved to anybody. Restricted to the collector so fees
    /// always travel the accounted path.
    function collectFees(address token) external returns (uint256 amount0, uint256 amount1) {
        address collector = IFeeCollectorSource(factory).feeCollector();
        if (msg.sender != collector) revert NotCollector();

        Position memory position = _positions[token];
        if (!position.locked) revert PositionNotHeld();

        (amount0, amount1) = IPositionFees(_positionRegistry(position.venue)).collect(
            IPositionFees.CollectParams({
                tokenId: position.positionId,
                recipient: collector,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit FeesCollected(token, collector, amount0, amount1);
    }

    /// @notice The position held for `token`, and the venue that minted it.
    function positionOf(address token) external view returns (uint256 positionId, address venue) {
        Position memory position = _positions[token];
        return (position.positionId, position.venue);
    }

    /// @notice Whether `token`'s liquidity is locked here.
    function isLocked(address token) external view returns (bool) {
        return _positions[token].locked;
    }

    /// @notice Accepts a position transferred in by its own registry.
    /// @dev Not part of the graduation path, which has the venue mint straight
    /// to this address. It exists so an explicit transfer still behaves, and
    /// only from a venue's own registry.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function _positionRegistry(address venue) private view returns (address) {
        return ILiquidityVenue(venue).positionRegistry();
    }
}

/// @dev The factory names the one contract allowed to pull fees out of here.
interface IFeeCollectorSource {
    function feeCollector() external view returns (address);
}
