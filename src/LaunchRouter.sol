// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BondingCurve} from "./BondingCurve.sol";
import {LaunchFactory} from "./LaunchFactory.sol";
import {LaunchParams} from "./interfaces/ILaunchpad.sol";

/// @title LaunchRouter
/// @notice Creates a launch and takes the first position on its curve in one
/// transaction.
///
/// Creating a launch and then buying into it as a second transaction leaves a
/// gap on a public curve. The gap is measured in blocks for a bot and in
/// seconds for a person holding a wallet prompt, and it is long enough to lose
/// the whole sellable allocation to whoever was watching for new launches.
///
/// Routing both legs through one call closes that gap outright rather than
/// narrowing it. The buy settles in the transaction that created the curve, so
/// there is no intermediate state for anyone to trade against, and a failed
/// buy reverts the launch with it instead of leaving behind a token its
/// creator never wanted on those terms.
///
/// This contract is the factory's trusted forwarder. It passes its own caller
/// through, so addresses are namespaced and the launch is attributed to the
/// real creator rather than to this router. It grants nobody access they did
/// not already have: its caller must pass the factory's own launch gate.
///
/// No balance is meant to survive a call. Both legs are funded by the caller
/// within it, and whatever the curve hands back is returned to them before it
/// returns.
contract LaunchRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error NotPermitted();
    error NativeValueMismatch(uint256 sent, uint256 expected);
    error RefundFailed();
    error ExemptionListTooLong();

    event Launched(
        address indexed token,
        address indexed curve,
        address indexed recipient,
        address creator,
        uint256 quoteSpent,
        uint256 tokensReceived
    );

    /// @dev The factory bounds the combined list at its own maximum, including
    /// the recipient this router appends.
    uint256 private constant MAX_EXEMPTIONS = 31;

    /// @notice The factory this router launches through.
    LaunchFactory public immutable factory;

    constructor(LaunchFactory factory_) {
        if (address(factory_) == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    /// @notice Creates a launch and buys `quoteIn` of its curve for `recipient`.
    /// @param params Launch parameters, forwarded untouched. The fee recipient
    /// must be explicit here, because the token recipient, the creator and the
    /// fee recipient can all be different addresses on this path.
    /// @param configId Launch configuration to use.
    /// @param quote Quote asset, or the zero address for a native launch.
    /// @param quoteIn Amount to spend on the opening buy. More than the curve
    /// can sell is clamped by the curve and the remainder comes back.
    /// @param minTokensOut Price floor for the opening buy, honoured even when
    /// the fill is clamped.
    /// @param recipient Receives the purchased tokens. Exempted from the
    /// opening tax automatically, so the first buy clears untaxed.
    /// @param taxExemptions Further wallets to exempt, for a team bundling its
    /// opening buys.
    /// @dev A native launch carries the launch fee and the buy together as
    /// value. An ERC-20 launch carries only the fee, and the buy is pulled from
    /// the caller, who must have approved this router first.
    function launchAndBuy(
        LaunchParams calldata params,
        uint256 configId,
        address quote,
        uint256 quoteIn,
        uint256 minTokensOut,
        address recipient,
        address[] calldata taxExemptions
    ) external payable nonReentrant returns (address token, address curve, uint256 tokensOut) {
        if (recipient == address(0) || params.feeRecipient == address(0)) revert ZeroAddress();
        if (quoteIn == 0) revert ZeroAmount();
        if (taxExemptions.length > MAX_EXEMPTIONS) revert ExemptionListTooLong();
        if (!factory.canLaunch(msg.sender)) revert NotPermitted();

        uint256 launchFee = factory.launchFee();
        bool nativeQuote = quote == address(0);
        uint256 expectedValue = nativeQuote ? launchFee + quoteIn : launchFee;
        if (msg.value != expectedValue) revert NativeValueMismatch(msg.value, expectedValue);

        // Measured on the leg the curve refunds in, and before this call funds
        // itself, so dust another caller left behind is never paid out here.
        uint256 balanceBefore =
            nativeQuote ? address(this).balance - msg.value : IERC20(quote).balanceOf(address(this));

        if (!nativeQuote) IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteIn);

        address[] memory exemptions = new address[](taxExemptions.length + 1);
        for (uint256 i = 0; i < taxExemptions.length; ++i) {
            exemptions[i] = taxExemptions[i];
        }
        exemptions[taxExemptions.length] = recipient;

        (token, curve) = factory.launchFor{value: launchFee}(params, configId, quote, msg.sender, exemptions);

        if (nativeQuote) {
            tokensOut = BondingCurve(payable(curve)).buy{value: quoteIn}(quoteIn, minTokensOut, recipient);
        } else {
            IERC20(quote).forceApprove(curve, quoteIn);
            tokensOut = BondingCurve(payable(curve)).buy(quoteIn, minTokensOut, recipient);
            // A clamped fill leaves part of the allowance standing.
            IERC20(quote).forceApprove(curve, 0);
        }

        _refund(quote, nativeQuote, balanceBefore);

        emit Launched(token, curve, recipient, msg.sender, quoteIn, tokensOut);
    }

    /// @dev Returns whatever the curve handed back for a buy it could not fill
    /// in full. The curve refunds its caller, which is this contract, so the
    /// excess would otherwise settle here rather than with whoever paid it.
    function _refund(address quote, bool nativeQuote, uint256 balanceBefore) private {
        if (nativeQuote) {
            uint256 refund = address(this).balance - balanceBefore;
            if (refund == 0) return;
            (bool sent,) = payable(msg.sender).call{value: refund}("");
            if (!sent) revert RefundFailed();
            return;
        }

        uint256 quoteRefund = IERC20(quote).balanceOf(address(this)) - balanceBefore;
        if (quoteRefund == 0) return;
        IERC20(quote).safeTransfer(msg.sender, quoteRefund);
    }

    /// @notice Accepts the native refund a partially filled curve returns.
    receive() external payable {}
}
