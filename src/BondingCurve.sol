// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {CurveMath} from "./libraries/CurveMath.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {FeePolicy, IBondingCurve, IBuybackVault, IFeeEscrow} from "./interfaces/ILaunchpad.sol";

/// @dev Terms the curve reads once from the factory when it initializes, in
/// the launch transaction itself, and then never again. Snapshotting rather
/// than reading live is what stops a configuration change reaching back into
/// a launch whose opening window is already running.
interface IOpeningTaxTerms {
    function openingTaxStartBps() external view returns (uint256);

    function openingTaxWindow() external view returns (uint256);
}

/// @dev The operator allowed to run price-sensitive sweeps, and the callback
/// the curve uses to ask the factory to graduate it.
interface IFactoryHooks {
    function feeSweepOperator() external view returns (address);

    function graduate(address token) external;
}

/// @title BondingCurve
/// @notice The market a launch trades on before it graduates: a
/// constant-product curve that holds the entire supply and will always both
/// sell and buy back.
///
/// Three decisions shape everything here.
///
/// The curve trades in the asset its future pool will use. Because it collects
/// that asset from the very first trade, graduation hands the pool exactly what
/// it needs with no swap in between, which means no router and no price oracle
/// anywhere in the system.
///
/// Fees are always charged on the quote leg, whichever way a trade goes. A buy
/// pays on the way in and a sell pays out of the proceeds, so the curve never
/// accrues revenue denominated in the launch token. Protocol and creator income
/// is real and liquid from the first trade rather than a pile of the token
/// being sold.
///
/// Part of the supply is reserved from the start and the curve will not sell
/// through it. That reserve is not a separate parameter: it is the token
/// balance that corresponds to the graduation target on this same curve, so
/// reserving it does not move where the launch graduates. It only makes the
/// pool deterministic. Every launch on the same configuration graduates into
/// the same pool, at the same price, whether the curve was bought out by one
/// order or by a thousand.
contract BondingCurve is ReentrancyGuard, IBondingCurve {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    /// @dev A taxed buy must still leave the buyer something. This floor also
    /// keeps the gross-up on a clamped fill from dividing by zero.
    uint256 private constant MIN_BUYER_SHARE_BPS = 100;

    error AlreadySettled();
    error NotSettled();
    error AlreadyInitialized();
    error NotInitialized();
    error NotFactory();
    error NotSweepOperator();
    error OperatorRequired();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidPolicy();
    error InvalidEconomics();
    error NotReady();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error MinimumOutputRequired();
    error NativeValueMismatch(uint256 sent, uint256 expected);
    error UnexpectedNativeValue();
    error TransferFailed();

    /// @dev `fee` carries the trade fee and, inside the opening window, the
    /// opening tax folded in with it, because both are distributed the same
    /// way. `creatorFee` is reported separately because it is not split.
    event Buy(
        address indexed buyer,
        address indexed recipient,
        uint256 quoteIn,
        uint256 tokensOut,
        uint256 fee,
        uint256 creatorFee
    );
    event Sell(
        address indexed seller,
        address indexed recipient,
        uint256 tokensIn,
        uint256 quoteOut,
        uint256 fee,
        uint256 creatorFee
    );
    event Refunded(address indexed buyer, uint256 amount);
    event OpeningTaxCharged(address indexed recipient, uint256 amount);
    event OpeningTaxExempted(address indexed account);
    event FeesSwept(uint256 treasuryAmount, uint256 buybackAmount, uint256 creatorAmount, uint256 tokensLocked);
    event FeesRescued(address indexed treasury, address indexed creator, uint256 treasuryAmount, uint256 creatorAmount);
    event BuybackSkipped(uint256 foldedBack);
    event Initialized(address token, uint256 supply, uint256 reserveFloor);
    event FeeRecipientUpdated(address indexed previous, address indexed current);
    event BuybackEnabledUpdated(bool enabled);
    event Settled(address recipient, uint256 quoteOut, uint256 tokenOut);
    event AutoGraduationFailed(address indexed token, uint256 gasRemaining);

    // --- Launch terms, fixed for the life of the curve -------------------

    /// @notice Protocol factory. The only privileged caller.
    address public immutable factory;

    /// @notice Quote asset of this launch. The zero address means native ETH.
    address public immutable quote;

    /// @notice Virtual quote reserve. Priced against but never withdrawable.
    uint256 public immutable virtualQuote;

    /// @notice Real quote the curve must collect before it graduates.
    uint256 public immutable graduationTarget;

    /// @notice Trade fee on the quote leg, in bps. Split three ways.
    uint16 public immutable tradeFeeBps;

    /// @notice Creator's own fee on the quote leg, in bps. Paid to them whole.
    uint16 public immutable creatorFeeBps;

    /// @notice Escrow every payout is credited to.
    IFeeEscrow public immutable escrow;

    /// @notice Vault bought-back supply vests in.
    IBuybackVault public immutable buybackVault;

    /// @notice Escrow key for the protocol's share.
    address public immutable treasury;

    /// @notice Protocol's share of the trade fee.
    uint16 public immutable treasuryShareBps;

    /// @notice Share of the creator's remainder spent on buybacks.
    uint16 public immutable buybackShareBps;

    /// @notice Ceiling on how far one buyback may move this curve's price.
    uint16 public immutable maxPriceImpactBps;

    /// @notice Beneficiary of a buyback vest, fixed so later rotations of the
    /// fee recipient do not split one launch's vest across schedules. The
    /// factory redirects the live beneficiary on the vault itself.
    address public immutable vestBeneficiary;

    // --- State -----------------------------------------------------------

    /// @notice The launch token. Set once, by the factory, in the launch
    /// transaction; the token's constructor needs this curve's address, so the
    /// two cannot both be immutable.
    address public token;

    /// @notice Receives the creator's share of fees. The factory rotates it.
    address public feeRecipient;

    /// @notice Whether this launch routes part of the creator's share into buybacks.
    bool public buybackEnabled;

    /// @notice True once the curve has handed its reserves to the factory.
    bool public settled;

    /// @notice Supply this launch was created with. Held here because the token
    /// is burnable, so its own `totalSupply` stops describing the launch.
    uint256 public launchSupply;

    /// @notice Token balance the curve will never sell below. Fixed at launch.
    uint256 public reserveFloor;

    /// @notice Quote the curve physically holds from trading. Tracked rather
    /// than read from the balance so that a transfer sent in from outside can
    /// neither move the price nor push the launch past its target.
    uint256 public trackedQuote;

    /// @notice Launch tokens held as tradeable reserve, tracked for the same
    /// reason: reading a live balance would let anyone reprice the curve, and
    /// shift what the graduated pool opens at, by sending tokens to it.
    uint256 public trackedTokens;

    /// @notice Trade fees charged and awaiting a sweep.
    uint256 public feeBalance;

    /// @notice The slice of `feeBalance` marked for buyback as each fee was
    /// charged. Marking at accrual rather than deriving it at sweep time keeps
    /// the buyback switch forward-looking: flipping it decides how the next
    /// trade's fee is split, never how an already-charged one is.
    uint256 public buybackEarmark;

    /// @notice Creator fees charged and awaiting a sweep.
    uint256 public creatorFeeBalance;

    /// @notice When trading opened. Anchors the opening tax.
    uint64 public openedAt;

    /// @notice Opening tax in the launch second, in bps of a buy.
    uint256 public openingTaxStartBps;

    /// @notice Seconds across which the opening tax decays to zero.
    uint256 public openingTaxWindow;

    /// @notice Addresses the creator declared at launch as exempt from the
    /// opening tax, so a team's own bundled buys are not consumed by it.
    mapping(address account => bool exempt) public openingTaxExempt;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    modifier onlyInitialized() {
        if (token == address(0)) revert NotInitialized();
        _;
    }

    constructor(
        address quote_,
        address feeRecipient_,
        address factory_,
        FeePolicy memory policy,
        IFeeEscrow escrow_,
        IBuybackVault buybackVault_,
        uint256 virtualQuote_,
        uint256 graduationTarget_,
        uint16 tradeFeeBps_,
        uint16 creatorFeeBps_,
        bool buybackEnabled_
    ) {
        if (feeRecipient_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        if (address(escrow_) == address(0) || address(buybackVault_) == address(0)) revert ZeroAddress();
        if (policy.treasury == address(0)) revert InvalidPolicy();
        if (policy.treasuryShareBps > BPS || policy.buybackShareBps > BPS) revert InvalidPolicy();
        if (policy.maxPriceImpactBps == 0 || policy.maxPriceImpactBps >= BPS) revert InvalidPolicy();
        if (virtualQuote_ == 0 || graduationTarget_ == 0) revert InvalidEconomics();
        // The factory applies the same ceiling before deploying, but the curve
        // enforces its own invariant rather than inheriting one: a combined fee
        // at or above the whole trade would break the quote accounting.
        if (uint256(tradeFeeBps_) + creatorFeeBps_ + MIN_BUYER_SHARE_BPS > BPS) revert InvalidPolicy();

        quote = quote_;
        feeRecipient = feeRecipient_;
        // Passed explicitly rather than read from `msg.sender`: the factory
        // deploys this curve through a helper to stay within the deployed-code
        // size limit, so `msg.sender` here is that helper.
        factory = factory_;
        escrow = escrow_;
        buybackVault = buybackVault_;
        treasury = policy.treasury;
        treasuryShareBps = policy.treasuryShareBps;
        buybackShareBps = policy.buybackShareBps;
        maxPriceImpactBps = policy.maxPriceImpactBps;
        vestBeneficiary = feeRecipient_;
        virtualQuote = virtualQuote_;
        graduationTarget = graduationTarget_;
        tradeFeeBps = tradeFeeBps_;
        creatorFeeBps = creatorFeeBps_;
        buybackEnabled = buybackEnabled_;
    }

    // --- Wiring, all factory-only ---------------------------------------

    /// @notice Binds the launch token and fixes the reserved allocation.
    /// @dev Cannot happen in the constructor because the supply is only known
    /// once the token exists. Called by the factory immediately after
    /// deploying the token, before either contract is reachable by anyone else.
    function initialize(address token_) external onlyFactory {
        if (token != address(0)) revert AlreadyInitialized();
        if (token_ == address(0)) revert ZeroAddress();
        token = token_;

        uint256 supply = IERC20(token_).totalSupply();
        uint256 floor = CurveMath.reserveFloor(supply, virtualQuote, graduationTarget);
        // A launch whose reserve rounds away has nothing to seed its pool with,
        // and one that reserves everything can never sell. Both are rejected
        // here, at launch, rather than at graduation.
        if (floor == 0 || floor >= supply) revert InvalidEconomics();

        launchSupply = supply;
        reserveFloor = floor;
        trackedTokens = IERC20(token_).balanceOf(address(this));
        openedAt = uint64(block.timestamp);
        openingTaxStartBps = IOpeningTaxTerms(factory).openingTaxStartBps();
        openingTaxWindow = IOpeningTaxTerms(factory).openingTaxWindow();

        emit Initialized(token_, supply, floor);
    }

    /// @notice Marks `account` exempt from the opening tax.
    /// @dev The factory calls this during the launch transaction for the
    /// creator, their fee recipient, and any wallets the creator declared, so a
    /// team's own opening buys clear untaxed while bots in the same seconds do
    /// not. Exemptions cannot be added later.
    function exemptFromOpeningTax(address account) external onlyFactory {
        if (account == address(0)) revert ZeroAddress();
        openingTaxExempt[account] = true;
        emit OpeningTaxExempted(account);
    }

    /// @notice Points future creator fees at a new address.
    /// @dev Factory-gated, because the factory is what authorises both a
    /// creator's own transfer and a protocol recovery. This contract therefore
    /// only has to trust one caller.
    function setFeeRecipient(address newRecipient) external onlyFactory {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// @notice Turns this launch's buyback route on or off.
    /// @dev Applies to fees charged from here on, never to fees already
    /// pending. Each trade marks its buyback slice as it is charged, so a
    /// toggle cannot reroute value that accrued under the opposite setting.
    function setBuybackEnabled(bool enabled) external onlyFactory {
        buybackEnabled = enabled;
        emit BuybackEnabledUpdated(enabled);
    }

    // --- Reads -----------------------------------------------------------

    /// @notice True when this launch trades in native ETH.
    function isNativeQuote() public view returns (bool) {
        return quote == address(0);
    }

    /// @notice Reserves to price a trade against, virtual quote included and
    /// fees awaiting a sweep excluded.
    function reserves() public view returns (uint256 quoteSide, uint256 tokenSide) {
        quoteSide = virtualQuote + trackedQuote - feeBalance - creatorFeeBalance;
        tokenSide = trackedTokens;
    }

    /// @notice Pricing quote reserve only.
    function quoteReserve() external view returns (uint256 amount) {
        (amount,) = reserves();
    }

    /// @notice Quote the curve physically holds, net of pending fees. The wrong
    /// input for pricing a trade; use `reserves`.
    function realQuoteReserve() public view returns (uint256) {
        return trackedQuote - feeBalance - creatorFeeBalance;
    }

    /// @notice Tokens the curve still holds, reserved allocation included.
    function tokenReserve() external view returns (uint256) {
        return trackedTokens;
    }

    /// @notice Tokens still buyable before the curve closes.
    function sellableTokens() public view returns (uint256) {
        uint256 held = trackedTokens;
        return held > reserveFloor ? held - reserveFloor : 0;
    }

    /// @notice True once the sellable allocation is gone.
    /// @dev Equivalent to the real quote reserve reaching the graduation
    /// target, since the reserve is derived from that same point, but stated
    /// against the token side because that is the side a trade cannot overshoot.
    function readyToGraduate() public view returns (bool) {
        if (settled) return false;
        return sellableTokens() == 0;
    }

    /// @notice Progress towards graduation, in bps of the target.
    function graduationProgressBps() external view returns (uint256) {
        uint256 raised = realQuoteReserve();
        if (raised >= graduationTarget) return BPS;
        return (raised * BPS) / graduationTarget;
    }

    /// @notice Opening tax `recipient` would pay on a buy landing right now.
    /// @dev Keyed on the recipient of the tokens rather than the sender,
    /// because exemptions belong to the wallet being bought for. A router must
    /// therefore ask about its end user, not about itself.
    function openingTaxBps(address recipient) public view returns (uint256) {
        if (openingTaxExempt[recipient]) return 0;
        uint256 raw = FeeMath.openingTaxBps(openingTaxStartBps, block.timestamp - openedAt, openingTaxWindow);
        return _boundOpeningTax(raw);
    }

    /// @notice Everything a buy of `quoteIn` for `recipient` would do right now.
    /// @dev The curve prices its own trades on chain so an interface, router or
    /// aggregator never has to reimplement this arithmetic and risk quoting
    /// something the trade will not honour. The figures returned are the ones
    /// `buy` computes, in the same integer order, so they match exactly when
    /// nothing moves in between.
    function quoteBuy(uint256 quoteIn, address recipient)
        public
        view
        returns (uint256 tokensOut, uint256 quoteSpent, uint256 refund, uint256 fee, uint256 creatorFee, uint256 tax)
    {
        if (quoteIn == 0 || settled) return (0, 0, quoteIn, 0, 0, 0);
        (uint256 quoteReserve_, uint256 tokenReserve_) = reserves();
        uint256 sellable = sellableTokens();
        if (sellable == 0) return (0, 0, quoteIn, 0, 0, 0);

        uint256 taxBps = openingTaxBps(recipient);
        quoteSpent = quoteIn;
        fee = (quoteSpent * tradeFeeBps) / BPS;
        creatorFee = (quoteSpent * creatorFeeBps) / BPS;
        tax = (quoteSpent * taxBps) / BPS;

        uint256 net = quoteSpent - fee - creatorFee - tax;
        tokensOut = CurveMath.quoteOut(net, quoteReserve_, tokenReserve_);

        if (tokensOut > sellable) {
            tokensOut = sellable;
            uint256 required = CurveMath.amountIn(sellable, quoteReserve_, tokenReserve_);
            quoteSpent = Math.min(
                Math.mulDiv(required, BPS, BPS - tradeFeeBps - creatorFeeBps - taxBps, Math.Rounding.Ceil), quoteIn
            );
            fee = (quoteSpent * tradeFeeBps) / BPS;
            creatorFee = (quoteSpent * creatorFeeBps) / BPS;
            tax = (quoteSpent * taxBps) / BPS;
        }

        refund = quoteIn - quoteSpent;
    }

    /// @notice What a sell of `tokensIn` would return right now.
    function quoteSell(uint256 tokensIn) public view returns (uint256 quoteOut, uint256 fee, uint256 creatorFee) {
        if (tokensIn == 0 || settled || readyToGraduate()) return (0, 0, 0);
        (uint256 quoteReserve_, uint256 tokenReserve_) = reserves();
        uint256 gross = CurveMath.quoteOut(tokensIn, tokenReserve_, quoteReserve_);
        fee = (gross * tradeFeeBps) / BPS;
        creatorFee = (gross * creatorFeeBps) / BPS;
        quoteOut = gross - fee - creatorFee;
    }

    // --- Trading ---------------------------------------------------------

    /// @notice Buys the launch token with this launch's quote asset.
    /// @dev `quoteIn` must equal the value sent for a native launch, and must
    /// come with no value at all for an ERC-20 launch. For an ERC-20 the amount
    /// credited is the balance actually received, so an asset that takes a cut
    /// on transfer cannot make the curve promise reserves it never got.
    ///
    /// A buy that would cross the reserved allocation is filled up to it,
    /// charged only for what it received, and refunded the rest in the same
    /// transaction. It is deliberately not rejected: the buy that finishes a
    /// launch is the one most likely to be sized against a state someone else
    /// has already moved, and reverting would let anyone grief it by slipping a
    /// small buy in front.
    ///
    /// Because the fill can shrink, `minTokensOut` bounds the price rather than
    /// the quantity. A caller who spends less than they offered cannot expect
    /// the whole amount they asked for, but they are still guaranteed never to
    /// pay a worse rate than their own arguments implied. When nothing is
    /// clamped this reduces exactly to `tokensOut >= minTokensOut`.
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        nonReentrant
        onlyInitialized
        returns (uint256 tokensOut)
    {
        if (settled) revert AlreadySettled();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 received = _receiveQuote(quoteIn);
        if (received == 0) revert ZeroAmount();
        // `settle` is deliberately not guarded, because it has to stay callable
        // from inside this function's own guarded scope, and graduation is
        // permissionless. A quote asset that yields control during its transfer
        // could therefore settle this curve between the check above and the
        // reads below, so the flag is re-checked here rather than relying on
        // the arithmetic downstream to happen to revert.
        if (settled) revert AlreadySettled();

        (uint256 quoteReserve_, uint256 tokenReserve_) = reserves();
        uint256 sellable = sellableTokens();
        if (sellable == 0) revert AlreadySettled();

        uint256 taxBps = openingTaxBps(recipient);
        uint256 spent = received;
        uint256 fee = (spent * tradeFeeBps) / BPS;
        uint256 creatorFee = (spent * creatorFeeBps) / BPS;
        uint256 tax = (spent * taxBps) / BPS;
        tokensOut = CurveMath.amountOut(spent - fee - creatorFee - tax, quoteReserve_, tokenReserve_);

        if (tokensOut > sellable) {
            tokensOut = sellable;
            // Price the clamped fill from the token side, then gross the result
            // back up so every fee leg still comes out of the input.
            uint256 required = CurveMath.amountIn(sellable, quoteReserve_, tokenReserve_);
            spent = Math.min(
                Math.mulDiv(required, BPS, BPS - tradeFeeBps - creatorFeeBps - taxBps, Math.Rounding.Ceil), received
            );
            fee = (spent * tradeFeeBps) / BPS;
            creatorFee = (spent * creatorFeeBps) / BPS;
            tax = (spent * taxBps) / BPS;
        }

        if (spent * minTokensOut > received * tokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        // The opening tax joins the trade fee, so it is split and swept exactly
        // like one. What a sniper gives up flows back into the launch instead of
        // being burned or paid to whoever happened to be watching.
        _accrueFees(fee + tax, creatorFee);
        trackedQuote += spent;
        trackedTokens -= tokensOut;
        IERC20(token).safeTransfer(recipient, tokensOut);

        uint256 refund = received - spent;
        if (refund != 0) {
            emit Refunded(msg.sender, refund);
            _sendQuote(msg.sender, refund);
        }

        if (tax != 0) emit OpeningTaxCharged(recipient, tax);
        emit Buy(msg.sender, recipient, spent, tokensOut, fee + tax, creatorFee);

        _tryGraduate();
    }

    /// @notice Sells the launch token back to the curve.
    /// @dev The fee comes out of the proceeds, so it is quote-denominated here
    /// too. Selling closes as soon as the curve is ready to graduate, slightly
    /// before the settled flag is set: from that moment the curve is holding
    /// the pool's reserves exactly, and a sell landing in that window would put
    /// tokens back and take quote out, seeding the pool deeper and cheaper than
    /// the reserved allocation fixes it at. The determinism of the graduation
    /// price only holds if the window is shut on both sides.
    ///
    /// This cannot strand a holder. Graduation is permissionless, so anyone
    /// refused here can settle the launch themselves in the same transaction
    /// and trade the pool instead.
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external
        nonReentrant
        onlyInitialized
        returns (uint256 quoteOut)
    {
        if (settled || readyToGraduate()) revert AlreadySettled();
        if (tokensIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        (uint256 quoteReserve_, uint256 tokenReserve_) = reserves();
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 gross = CurveMath.amountOut(tokensIn, tokenReserve_, quoteReserve_);
        uint256 fee = (gross * tradeFeeBps) / BPS;
        uint256 creatorFee = (gross * creatorFeeBps) / BPS;
        quoteOut = gross - fee - creatorFee;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);

        _accrueFees(fee, creatorFee);
        trackedQuote -= quoteOut;
        trackedTokens += tokensIn;
        _sendQuote(recipient, quoteOut);

        emit Sell(msg.sender, recipient, tokensIn, quoteOut, fee, creatorFee);
    }

    // --- Fees ------------------------------------------------------------

    /// @notice Distributes pending fees to the protocol, the buyback and the
    /// creator under this launch's recorded policy.
    /// @dev The protocol's sweep operator is required whenever the sweep would
    /// execute a buyback, because that leg trades against this curve at a price
    /// the caller could otherwise choose the moment for. The creator may still
    /// distribute fees whenever no trade is needed.
    function sweepFees(uint256 minBuybackTokensOut) external nonReentrant onlyInitialized {
        if (settled) revert AlreadySettled();
        bool isOperator = msg.sender == IFactoryHooks(factory).feeSweepOperator();
        if (!isOperator && msg.sender != feeRecipient) revert NotSweepOperator();
        if (!isOperator && buybackEarmark != 0) revert OperatorRequired();
        _sweepFees(minBuybackTokensOut, true);
    }

    /// @notice Hands the curve's reserves to the factory so it can list the
    /// launch, and closes trading for good.
    /// @dev Factory-only, and deliberately not reentrancy-guarded so it stays
    /// callable from inside `buy`'s own guarded scope: the buy that finishes a
    /// launch graduates it in the same transaction.
    function settle(address recipient) external onlyFactory returns (uint256 quoteOut, uint256 tokenOut) {
        if (settled) revert AlreadySettled();
        if (recipient == address(0)) revert ZeroAddress();
        if (!readyToGraduate()) revert NotReady();

        // Close trading before the sweep, not after. The sweep pays the escrow,
        // and a quote asset with a transfer callback could re-enter `buy` or
        // `sell` from inside that payment. Since this function cannot be
        // guarded, the flag is the only thing shutting that window: re-entering
        // while it was still false would refill the fee buckets after they had
        // been zeroed, leaving balances with no reserves behind them.
        settled = true;

        // Graduation can be triggered by any caller, including the buyer who
        // crossed the target. The buyback is skipped rather than executed as a
        // predictable market order without the operator's minimum output.
        _sweepFees(0, false);

        // Only tracked reserves are handed over. Anything sent to this curve
        // from outside is deliberately left behind rather than folded into the
        // pool's seed, so a donation cannot move the price the pool opens at.
        quoteOut = trackedQuote;
        trackedQuote = 0;
        tokenOut = trackedTokens;
        trackedTokens = 0;

        if (quoteOut != 0) _sendQuote(recipient, quoteOut);
        if (tokenOut != 0) IERC20(token).safeTransfer(recipient, tokenOut);

        emit Settled(recipient, quoteOut, tokenOut);
    }

    /// @notice Pays pending fees straight to the protocol and the creator,
    /// bypassing the escrow.
    /// @dev Exists for one failure mode: a quote asset that stops delivering to
    /// the escrow's single address while still permitting transfers between
    /// traders and this curve. Trading would carry on normally but the fees
    /// would be unreachable, and graduation unreachable with them, because
    /// settlement sweeps before handing over reserves and fees accrue from the
    /// first trade. Clearing the buckets here is what lets that launch
    /// graduate: the sweep inside `settle` then finds nothing pending.
    ///
    /// The buyback slice is paid to the creator rather than executed, because
    /// it would have to settle through the same escrow this path exists to
    /// route around.
    function rescueFees() external onlyFactory returns (uint256 treasuryAmount, uint256 creatorAmount) {
        uint256 pending = feeBalance;
        uint256 creatorPending = creatorFeeBalance;
        if (pending == 0 && creatorPending == 0) revert ZeroAmount();

        treasuryAmount = (pending * treasuryShareBps) / BPS;
        creatorAmount = pending - treasuryAmount + creatorPending;

        feeBalance = 0;
        // Cleared with the balance it marked. Leaving it would let a settled
        // claim survive into the next accrual and divert fees the creator has
        // not earned yet into the vest.
        buybackEarmark = 0;
        creatorFeeBalance = 0;
        trackedQuote -= treasuryAmount + creatorAmount;

        if (treasuryAmount != 0) _sendQuote(treasury, treasuryAmount);
        if (creatorAmount != 0) _sendQuote(feeRecipient, creatorAmount);

        emit FeesRescued(treasury, feeRecipient, treasuryAmount, creatorAmount);
    }

    // --- Internals -------------------------------------------------------

    /// @dev Books a trade's fees and marks the buyback slice at the moment it is
    /// charged. The slice is measured against what remains after the protocol's
    /// share, so it is funded from the creator's side alone, and the creator fee
    /// never enters the split at all.
    function _accrueFees(uint256 fee, uint256 creatorFee) private {
        feeBalance += fee;
        creatorFeeBalance += creatorFee;
        if (buybackEnabled && fee != 0) {
            uint256 creatorShare = fee - (fee * treasuryShareBps) / BPS;
            buybackEarmark += (creatorShare * buybackShareBps) / BPS;
        }
    }

    /// @dev Splits pending fees, buying the launch token back against this
    /// curve's own reserves for the buyback leg and locking the result into the
    /// vest rather than burning it. The buyback answers to the same reserve
    /// floor a buy does, so as a launch nears graduation it folds back into the
    /// creator's payout instead of eating the pool's allocation.
    function _sweepFees(uint256 minBuybackTokensOut, bool executeBuyback) private {
        uint256 pending = feeBalance;
        uint256 creatorPending = creatorFeeBalance;
        if (pending == 0 && creatorPending == 0) return;

        // The protocol's share comes off the whole fee first. The buyback leg
        // is not recomputed here: it is taken from the mark that was set as
        // each fee was charged, so the switch stays forward-looking.
        uint256 treasuryAmount = (pending * treasuryShareBps) / BPS;
        uint256 creatorShare = pending - treasuryAmount;
        // The earmark was summed per trade, so its rounding can land a wei or
        // two above the share recomputed here on the aggregate. Clamping keeps
        // the subtraction sound at a full buyback share, where the two would
        // otherwise be equal.
        uint256 buybackAmount = executeBuyback ? Math.min(buybackEarmark, creatorShare) : 0;
        uint256 creatorAmount = creatorShare - buybackAmount + creatorPending;

        uint256 tokensLocked;
        if (buybackAmount != 0) {
            if (minBuybackTokensOut == 0) revert MinimumOutputRequired();
            tokensLocked = _priceBuyback(buybackAmount);
            if (tokensLocked == 0) {
                // Curve too thin, or the buyback would move its price too far.
                // Fold it back into the creator's payout.
                emit BuybackSkipped(buybackAmount);
                creatorAmount += buybackAmount;
                buybackAmount = 0;
            } else if (tokensLocked < minBuybackTokensOut) {
                // Only a buyback that actually executes answers to the caller's
                // minimum. Applying it to the fold-back branch would make that
                // branch unreachable and strand fees exactly when the curve is
                // too thin to buy back.
                revert SlippageExceeded(tokensLocked, minBuybackTokensOut);
            }
        }

        feeBalance = 0;
        // Cleared whether the buyback executed, folded back, or was skipped
        // outright by settlement: the fees behind the mark are now distributed.
        buybackEarmark = 0;
        creatorFeeBalance = 0;
        // Only the legs that leave the contract reduce tracked quote. The
        // buyback's quote stays as reserve, because the tokens it bought came
        // out of the token side.
        trackedQuote -= treasuryAmount + creatorAmount;

        if (tokensLocked != 0) {
            trackedTokens -= tokensLocked;
            IERC20(token).forceApprove(address(buybackVault), tokensLocked);
            buybackVault.lock(token, tokensLocked, vestBeneficiary, treasury, treasuryShareBps);
            IERC20(token).forceApprove(address(buybackVault), 0);
        }
        if (treasuryAmount != 0) _creditQuote(treasury, treasuryAmount);
        if (creatorAmount != 0) _creditQuote(feeRecipient, creatorAmount);

        emit FeesSwept(treasuryAmount, buybackAmount, creatorAmount, tokensLocked);
    }

    /// @dev Tokens a buyback of `quoteAmount` would receive, or zero when it
    /// must be skipped: too large a price move, nothing priceable, or more than
    /// the sellable allocation can give up.
    function _priceBuyback(uint256 quoteAmount) private view returns (uint256) {
        (uint256 quoteReserve_, uint256 tokenReserve_) = reserves();
        uint256 movementBps = (quoteAmount * BPS) / (quoteReserve_ + quoteAmount);
        if (movementBps > maxPriceImpactBps) return 0;

        uint256 tokensOut = CurveMath.quoteOut(quoteAmount, quoteReserve_, tokenReserve_);
        if (tokensOut == 0 || tokensOut > sellableTokens()) return 0;
        return tokensOut;
    }

    /// @dev Caps the opening tax so a taxed buy always nets the buyer
    /// something, and so the gross-up on a clamped fill cannot divide by zero.
    /// It deliberately ignores the ordinary combined-fee ceiling: a near-total
    /// take in the launch second is the whole point of the mechanism.
    function _boundOpeningTax(uint256 taxBps) private view returns (uint256) {
        if (taxBps == 0) return 0;
        uint256 max = BPS - tradeFeeBps - creatorFeeBps - MIN_BUYER_SHARE_BPS;
        return taxBps > max ? max : taxBps;
    }

    /// @dev Pulls `amount` of the quote asset in and returns what arrived.
    function _receiveQuote(uint256 amount) private returns (uint256) {
        if (isNativeQuote()) {
            if (msg.value != amount) revert NativeValueMismatch(msg.value, amount);
            return amount;
        }
        if (msg.value != 0) revert UnexpectedNativeValue();

        IERC20 asset = IERC20(quote);
        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        return asset.balanceOf(address(this)) - before;
    }

    function _sendQuote(address recipient, uint256 amount) private {
        if (isNativeQuote()) {
            (bool sent,) = payable(recipient).call{value: amount}("");
            if (!sent) revert TransferFailed();
            return;
        }
        IERC20(quote).safeTransfer(recipient, amount);
    }

    function _creditQuote(address recipient, uint256 amount) private {
        if (isNativeQuote()) {
            escrow.credit{value: amount}(recipient);
            return;
        }
        IERC20(quote).forceApprove(address(escrow), amount);
        escrow.creditToken(recipient, quote, amount);
        IERC20(quote).forceApprove(address(escrow), 0);
    }

    /// @dev Graduates the launch inside the buy that finished it, so the
    /// migration needs no second transaction and no keeper in the normal case.
    /// Wrapped in try/catch because the underlying buy must still succeed if
    /// graduation cannot complete, and graduation stays permissionlessly
    /// retryable. The failure is announced rather than swallowed: the crossing
    /// buyer sets their own gas limit and can starve this call, pushing the
    /// cost onto whoever acts next, so the event is what lets anyone notice a
    /// launch sitting finished but unlisted.
    function _tryGraduate() private {
        if (!readyToGraduate()) return;
        try IFactoryHooks(factory).graduate(token) {}
        catch {
            emit AutoGraduationFailed(token, gasleft());
        }
    }

    /// @notice Accepts native quote sent by a trade or returned as a refund.
    receive() external payable {}
}
