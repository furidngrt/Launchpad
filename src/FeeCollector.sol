// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IWrappedNative} from "./interfaces/IAmmV3.sol";
import {
    FeeMath
} from "./libraries/FeeMath.sol";
import {
    FeePolicy,
    IBuybackVault,
    IFeeEscrow,
    ILaunchRegistry,
    ILiquidityVenue,
    Launch,
    Phase
} from "./interfaces/ILaunchpad.sol";

/// @dev What the collector needs from the factory beyond the launch record.
interface IFactoryTerms {
    function feeSweepOperator() external view returns (address);
}

/// @dev The one call the collector makes into the locker.
interface ILockerFees {
    function collectFees(address token) external returns (uint256 amount0, uint256 amount1);
}

/// @title FeeCollector
/// @notice Splits the trading fees a launch earns after it has graduated.
///
/// Before graduation the curve charges its fee on the quote leg of every
/// trade, so revenue is already in the asset the creator is paid in. A pool
/// cannot work that way: which side a fee lands on depends on the direction of
/// the swap, so a graduated launch accrues a mixture of its own token and its
/// quote asset. This contract is what restores the pre-graduation guarantee.
/// It converts the launch-token side back to the quote asset against the
/// pool's own liquidity, and only then splits and pays out, so a creator is
/// paid in the asset their launch traded in, before and after graduation
/// alike, and never handed an illiquid pile of their own token.
///
/// Conversions are price-sensitive, and price-sensitive calls are restricted
/// to the protocol's sweep operator, who supplies an explicit minimum output.
/// A creator can still distribute fees themselves whenever no conversion is
/// needed. A conversion that cannot be done at an acceptable price is left for
/// later rather than forced through, and a reader can tell that happened from
/// the events.
contract FeeCollector is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error UnknownLaunch();
    error NotListed();
    error NotOperator();
    error OperatorRequired();
    error MinimumOutputRequired();
    error NothingToCollect();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error TransferFailed();

    event FeesCollected(address indexed token, uint256 tokenFees, uint256 quoteFees);
    event FeesConverted(address indexed token, uint256 tokenIn, uint256 quoteOut);
    event ConversionSkipped(address indexed token, uint256 tokenFees);
    event FeesDistributed(
        address indexed token, uint256 treasuryAmount, uint256 buybackAmount, uint256 creatorAmount, uint256 tokensLocked
    );
    event BuybackSkipped(address indexed token, uint256 foldedBack);

    /// @notice The protocol's launch registry.
    ILaunchRegistry public immutable registry;

    /// @notice Permanent custody of graduated liquidity.
    ILockerFees public immutable locker;

    /// @notice Pull-payment ledger every payout is credited to.
    IFeeEscrow public immutable escrow;

    /// @notice Vault bought-back supply vests in.
    IBuybackVault public immutable buybackVault;

    constructor(ILaunchRegistry registry_, ILockerFees locker_, IFeeEscrow escrow_, IBuybackVault buybackVault_) {
        if (address(registry_) == address(0) || address(locker_) == address(0)) revert ZeroAddress();
        if (address(escrow_) == address(0) || address(buybackVault_) == address(0)) revert ZeroAddress();

        registry = registry_;
        locker = locker_;
        escrow = escrow_;
        buybackVault = buybackVault_;
    }

    /// @notice Collects, converts and distributes one launch's pool fees.
    /// @param token The launch.
    /// @param minQuoteOut Floor on the quote received for converting the
    /// launch-token side. Required whenever there is anything to convert.
    /// @param minBuybackTokensOut Floor on the tokens a buyback must receive.
    /// Required whenever a buyback is due.
    /// @dev Open to the protocol's sweep operator and to the launch's own fee
    /// recipient. The recipient's call is refused when the work would need a
    /// conversion or a buyback, because those trade against a live pool at a
    /// price the caller would otherwise be choosing the moment for.
    function collect(address token, uint256 minQuoteOut, uint256 minBuybackTokensOut) external nonReentrant {
        Launch memory launch = registry.getLaunch(token);
        if (!launch.exists) revert UnknownLaunch();
        if (launch.phase != Phase.Listed) revert NotListed();

        bool isOperator = msg.sender == IFactoryTerms(address(registry)).feeSweepOperator();
        if (!isOperator && msg.sender != launch.feeRecipient) revert NotOperator();

        address quoteToken = _quoteToken(launch);
        (uint256 tokenFees, uint256 quoteFees) = _collect(token, quoteToken, launch);
        if (tokenFees == 0 && quoteFees == 0) revert NothingToCollect();
        emit FeesCollected(token, tokenFees, quoteFees);

        uint256 quoteTotal = quoteFees;
        if (tokenFees != 0) {
            if (!isOperator) revert OperatorRequired();
            quoteTotal += _convert(token, quoteToken, launch, tokenFees, minQuoteOut);
        }
        if (quoteTotal == 0) return;

        FeePolicy memory policy = registry.getFeePolicy(token);
        (uint256 treasuryAmount, uint256 buybackAmount, uint256 creatorAmount) =
            FeeMath.split(quoteTotal, policy.treasuryShareBps, policy.buybackShareBps, launch.buybackEnabled);

        if (buybackAmount != 0 && !isOperator) revert OperatorRequired();

        uint256 tokensLocked;
        if (buybackAmount != 0) {
            if (minBuybackTokensOut == 0) revert MinimumOutputRequired();
            tokensLocked = _buyback(token, quoteToken, launch, buybackAmount, minBuybackTokensOut, policy);
            if (tokensLocked == 0) {
                // The buyback could not be done sensibly. Its value is paid to
                // the creator rather than left stranded, and the skip is
                // announced so it is never mistaken for a purchase.
                emit BuybackSkipped(token, buybackAmount);
                creatorAmount += buybackAmount;
                buybackAmount = 0;
            }
        }

        _payOut(launch, quoteToken, policy.treasury, treasuryAmount);
        _payOut(launch, quoteToken, launch.feeRecipient, creatorAmount);

        emit FeesDistributed(token, treasuryAmount, buybackAmount, creatorAmount, tokensLocked);
    }

    /// @notice Fees this contract is holding for `token` but has not yet paid
    /// out, so an interface can show a creator their true position rather than
    /// only what has reached the escrow.
    function pending(address token) external view returns (uint256 tokenAmount, uint256 quoteAmount) {
        Launch memory launch = registry.getLaunch(token);
        if (!launch.exists) return (0, 0);
        tokenAmount = IERC20(token).balanceOf(address(this));
        quoteAmount = IERC20(_quoteToken(launch)).balanceOf(address(this));
    }

    function _collect(address token, address quoteToken, Launch memory launch)
        private
        returns (uint256 tokenFees, uint256 quoteFees)
    {
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        uint256 quoteBefore = IERC20(quoteToken).balanceOf(address(this));

        locker.collectFees(token);

        // Measure what arrived rather than trusting the amounts reported, and
        // read the two sides off the balances so the pool's own ordering of its
        // assets never has to be replicated here.
        tokenFees = IERC20(token).balanceOf(address(this)) - tokenBefore;
        quoteFees = IERC20(quoteToken).balanceOf(address(this)) - quoteBefore;
        launch;
    }

    function _convert(
        address token,
        address quoteToken,
        Launch memory launch,
        uint256 tokenFees,
        uint256 minQuoteOut
    ) private returns (uint256 quoteOut) {
        if (minQuoteOut == 0) revert MinimumOutputRequired();

        IERC20(token).forceApprove(launch.venue, tokenFees);
        try ILiquidityVenue(launch.venue).swap(token, quoteToken, launch.venueFee, tokenFees, minQuoteOut, address(this))
        returns (uint256 received) {
            quoteOut = received;
            emit FeesConverted(token, tokenFees, received);
        } catch {
            // Leaving the token side here is the conservative outcome: it stays
            // collected and converts on a later call, instead of the whole
            // distribution reverting over one leg.
            quoteOut = 0;
            emit ConversionSkipped(token, tokenFees);
        }
        IERC20(token).forceApprove(launch.venue, 0);
    }

    function _buyback(
        address token,
        address quoteToken,
        Launch memory launch,
        uint256 quoteAmount,
        uint256 minTokensOut,
        FeePolicy memory policy
    ) private returns (uint256 tokensLocked) {
        IERC20(quoteToken).forceApprove(launch.venue, quoteAmount);
        try ILiquidityVenue(launch.venue).swap(
            quoteToken, token, launch.venueFee, quoteAmount, minTokensOut, address(this)
        ) returns (uint256 received) {
            tokensLocked = received;
        } catch {
            tokensLocked = 0;
        }
        IERC20(quoteToken).forceApprove(launch.venue, 0);

        if (tokensLocked == 0) return 0;
        if (tokensLocked < minTokensOut) revert SlippageExceeded(tokensLocked, minTokensOut);

        IERC20(token).forceApprove(address(buybackVault), tokensLocked);
        buybackVault.lock(token, tokensLocked, launch.feeRecipient, policy.treasury, policy.treasuryShareBps);
        IERC20(token).forceApprove(address(buybackVault), 0);
    }

    /// @dev Credits `amount` to `recipient`, unwrapping first for a launch
    /// quoted in the native asset so a creator's balance stays on one ledger
    /// rather than being split between native and wrapped forms.
    function _payOut(Launch memory launch, address quoteToken, address recipient, uint256 amount) private {
        if (amount == 0) return;

        if (launch.quote == address(0)) {
            IWrappedNative(quoteToken).withdraw(amount);
            escrow.credit{value: amount}(recipient);
            return;
        }
        IERC20(quoteToken).forceApprove(address(escrow), amount);
        escrow.creditToken(recipient, quoteToken, amount);
        IERC20(quoteToken).forceApprove(address(escrow), 0);
    }

    function _quoteToken(Launch memory launch) private view returns (address) {
        return launch.quote == address(0) ? ILiquidityVenue(launch.venue).wrappedNative() : launch.quote;
    }

    /// @notice Accepts native value from unwrapping.
    receive() external payable {}
}
