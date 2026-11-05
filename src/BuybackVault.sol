// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IBuybackVault, IFeeEscrow, ILaunchRegistry} from "./interfaces/ILaunchpad.sol";

/// @title BuybackVault
/// @notice Holds supply bought back out of fees and releases it slowly instead
/// of burning it.
///
/// A burn is irreversible and invisible afterwards; a long vest is neither. The
/// tokens stay accounted for, nobody receives a lump sum, and there is no point
/// at which a large balance can return to the market at once. Releases are
/// split between the creator and the protocol on the share recorded for that
/// launch.
///
/// Note who funds this. Both the curve and the post-graduation collector carve
/// the buyback slice out of the creator's share of the fee alone, so the
/// creator funds the whole lock and then receives only their share of it back.
/// Enabling buybacks therefore moves value from the creator to the protocol
/// relative to simply taking the fee, by an amount that grows with the buyback
/// share. That is why only the creator may switch it on.
///
/// Deposits use one weighted clock per launch rather than a list of tranches.
/// A launch can top up its lock on every single fee sweep, and an unbounded
/// list of tranches would make releasing cost more gas forever. Instead each
/// deposit moves the launch's single vesting end forward in proportion to its
/// share of the new total: a small top-up barely disturbs a large existing
/// lock, and a large one pulls a small lock most of the way to its own clock.
contract BuybackVault is ReentrancyGuard, IBuybackVault {
    using SafeERC20 for IERC20;

    struct Vest {
        uint256 totalLocked;
        uint256 totalReleased;
        /// @dev Vested but not yet paid out.
        uint256 vestedUnreleased;
        /// @dev Still vesting.
        uint256 unvested;
        uint64 lastUpdate;
        uint64 vestingEnd;
        address creatorRecipient;
        address treasury;
        uint16 treasuryShareBps;
    }

    uint256 private constant BPS = 10_000;

    /// @notice How long a deposit takes to vest in full.
    uint256 public constant VESTING_DURATION = 5 * 365 days;

    error ZeroAddress();
    error AlreadyInitialized();
    error NotFactory();
    error NotAuthorized();
    error NotBeneficiary();
    error InvalidTerms();
    error TermsMismatch();

    event FactorySet(address factory);
    event Locked(address indexed token, address indexed payer, uint256 amount, uint64 vestingEnd);
    event TermsRecorded(address indexed token, address indexed creatorRecipient, address indexed treasury, uint16 bps);
    event Released(address indexed token, uint256 creatorAmount, uint256 treasuryAmount);
    event CreatorRecipientUpdated(address indexed token, address indexed previous, address indexed current);

    /// @notice Shared pull-payment ledger releases are credited to.
    IFeeEscrow public immutable escrow;

    /// @notice Protocol factory, the only contract allowed to redirect a vest.
    address public factory;

    /// @dev Set once by the deployer, then this contract has no admin at all.
    address private _initializer;

    mapping(address token => Vest) private _vests;

    constructor(IFeeEscrow escrow_, address initializer_) {
        if (address(escrow_) == address(0) || initializer_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        _initializer = initializer_;
    }

    /// @notice Wires the factory once, after both are deployed.
    /// @dev The factory's constructor needs this vault's address, so the two
    /// cannot both be immutable. The right to call this is consumed here,
    /// leaving the vault with no privileged role of any kind.
    function setFactory(address factory_) external {
        if (msg.sender != _initializer) revert NotAuthorized();
        if (factory != address(0)) revert AlreadyInitialized();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        _initializer = address(0);
        emit FactorySet(factory_);
    }

    /// @notice Locks `amount` of `token` into its vest.
    /// @dev Callable only by the contract that performed the buyback for this
    /// token: the launch's own curve, looked up live from the factory, or the
    /// post-graduation collector the factory names. No per-launch
    /// authorisation step is ever needed.
    function lock(address token, uint256 amount, address creatorRecipient, address treasury, uint16 treasuryShareBps)
        external
        nonReentrant
    {
        if (token == address(0)) revert ZeroAddress();
        if (factory == address(0)) revert NotFactory();
        if (!_isAuthorized(token, msg.sender)) revert NotAuthorized();
        if (amount == 0) return;
        if (creatorRecipient == address(0) || treasury == address(0) || treasuryShareBps > BPS) revert InvalidTerms();

        // Schedule against what arrived, not what was promised. Recording an
        // amount this vault never received would make the final release of the
        // schedule revert against its own balance, stranding the tail.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        amount = IERC20(token).balanceOf(address(this)) - before;
        if (amount == 0) return;

        Vest storage vest = _vests[token];
        uint64 now_ = uint64(block.timestamp);
        _checkpoint(vest, now_);
        _recordTerms(vest, token, creatorRecipient, treasury, treasuryShareBps);

        uint256 unvested = vest.unvested;
        uint256 combined = unvested + amount;
        uint256 remaining = unvested == 0 ? 0 : vest.vestingEnd - now_;
        // Weighted blend of the old schedule's remaining time and a fresh one.
        uint256 duration = (unvested * remaining + amount * VESTING_DURATION) / combined;

        vest.unvested = combined;
        vest.lastUpdate = now_;
        vest.vestingEnd = now_ + uint64(duration);
        vest.totalLocked += amount;

        emit Locked(token, msg.sender, amount, vest.vestingEnd);
    }

    /// @notice Pays out everything vested so far for `token`.
    /// @dev Restricted to the two parties a release pays. Letting anyone choose
    /// the moment is harmful twice over: a caller could time a release inside a
    /// pending recipient change, flushing tokens to the very address the change
    /// exists to abandon, and a caller could advance the clock every second so
    /// each step rounds its newly vested amount down to zero and the vest
    /// stalls without ever paying out. Either beneficiary calling pays both, so
    /// neither side can strand the other.
    function release(address token) external nonReentrant returns (uint256 released) {
        Vest storage vest = _vests[token];
        if (msg.sender != vest.creatorRecipient && msg.sender != vest.treasury) revert NotBeneficiary();

        _checkpoint(vest, uint64(block.timestamp));
        released = vest.vestedUnreleased;
        if (released == 0) return 0;

        vest.vestedUnreleased = 0;
        vest.totalReleased += released;

        uint256 treasuryAmount = (released * vest.treasuryShareBps) / BPS;
        uint256 creatorAmount = released - treasuryAmount;

        IERC20(token).forceApprove(address(escrow), released);
        if (treasuryAmount != 0) escrow.creditToken(vest.treasury, token, treasuryAmount);
        if (creatorAmount != 0) escrow.creditToken(vest.creatorRecipient, token, creatorAmount);
        IERC20(token).forceApprove(address(escrow), 0);

        emit Released(token, creatorAmount, treasuryAmount);
    }

    /// @notice Points a launch's vest at a new creator recipient.
    /// @dev Only the factory calls this, and it does so for both a creator's
    /// own transfer and a protocol recovery. Vested but unreleased tokens move
    /// with it, which is the point: a vest that stayed behind on a lost wallet
    /// would defeat the recovery. The protocol's split terms stay bound to the
    /// launch snapshot and are not touched here.
    function updateCreatorRecipient(address token, address newRecipient) external {
        if (msg.sender != factory) revert NotFactory();
        if (token == address(0) || newRecipient == address(0)) revert ZeroAddress();

        Vest storage vest = _vests[token];
        address previous = vest.creatorRecipient;
        if (previous == newRecipient) return;
        vest.creatorRecipient = newRecipient;
        emit CreatorRecipientUpdated(token, previous, newRecipient);
    }

    /// @notice Everything an interface needs about one launch's vest.
    function vestOf(address token) external view returns (Vest memory) {
        return _vests[token];
    }

    /// @notice Total ever locked for `token`.
    function totalLocked(address token) external view returns (uint256) {
        return _vests[token].totalLocked;
    }

    /// @notice Total already released for `token`.
    function totalReleased(address token) external view returns (uint256) {
        return _vests[token].totalReleased;
    }

    /// @notice Amount vested so far, released or not.
    function vestedAmount(address token) external view returns (uint256) {
        Vest storage vest = _vests[token];
        return vest.totalReleased + vest.vestedUnreleased + _newlyVested(vest, uint64(block.timestamp));
    }

    /// @notice Amount that could be released right now.
    function releasable(address token) external view returns (uint256) {
        Vest storage vest = _vests[token];
        return vest.vestedUnreleased + _newlyVested(vest, uint64(block.timestamp));
    }

    /// @notice Beneficiaries and split recorded for `token`'s current schedule.
    function terms(address token)
        external
        view
        returns (address creatorRecipient, address treasury, uint16 treasuryShareBps)
    {
        Vest storage vest = _vests[token];
        return (vest.creatorRecipient, vest.treasury, vest.treasuryShareBps);
    }

    /// @dev Banks whatever vested since the last update, so a later deposit
    /// cannot pull already-vested tokens back under a longer schedule.
    function _checkpoint(Vest storage vest, uint64 now_) private {
        uint256 newly = _newlyVested(vest, now_);
        if (newly != 0) {
            vest.unvested -= newly;
            vest.vestedUnreleased += newly;
        }
        vest.lastUpdate = now_;
    }

    function _newlyVested(Vest storage vest, uint64 now_) private view returns (uint256) {
        if (vest.unvested == 0 || now_ <= vest.lastUpdate) return 0;
        if (now_ >= vest.vestingEnd) return vest.unvested;
        uint256 remaining = vest.vestingEnd - vest.lastUpdate;
        uint256 elapsed = now_ - vest.lastUpdate;
        return Math.mulDiv(vest.unvested, elapsed, remaining);
    }

    /// @dev A schedule's split terms are fixed while anything is outstanding. A
    /// fresh schedule may record new ones, except for the creator recipient,
    /// which is managed through `updateCreatorRecipient` so a recovery is never
    /// quietly reverted by the next deposit.
    function _recordTerms(
        Vest storage vest,
        address token,
        address creatorRecipient,
        address treasury,
        uint16 treasuryShareBps
    ) private {
        if (vest.unvested == 0 && vest.vestedUnreleased == 0) {
            if (vest.creatorRecipient == address(0)) vest.creatorRecipient = creatorRecipient;
            vest.treasury = treasury;
            vest.treasuryShareBps = treasuryShareBps;
            emit TermsRecorded(token, vest.creatorRecipient, treasury, treasuryShareBps);
            return;
        }
        if (vest.treasury != treasury || vest.treasuryShareBps != treasuryShareBps) revert TermsMismatch();
    }

    function _isAuthorized(address token, address caller) private view returns (bool) {
        ILaunchRegistry registry = ILaunchRegistry(factory);
        if (caller == registry.getLaunch(token).curve) return true;
        return caller == IFeeCollectorSource(factory).feeCollector();
    }
}

/// @dev The factory names the one contract allowed to lock buybacks for
/// launches that have already graduated.
interface IFeeCollectorSource {
    function feeCollector() external view returns (address);
}
