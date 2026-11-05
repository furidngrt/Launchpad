// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BondingCurve} from "./BondingCurve.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {
    FeePolicy,
    IBuybackVault,
    IFeeEscrow,
    ILaunchDeployer,
    ILaunchRegistry,
    ILiquidityLocker,
    ILiquidityVenue,
    Launch,
    LaunchConfig,
    LaunchParams,
    Phase,
    QuoteAssetTerms
} from "./interfaces/ILaunchpad.sol";

/// @title LaunchFactory
/// @notice The protocol's entry point. It creates launches, holds the terms
/// they are created on, and drives graduation into a permanently locked pool.
///
/// Authority is split across roles rather than held by one owner, so no single
/// key can both reprice launches and move value. The admin role that grants the
/// others can only be handed over after a delay, which means a transfer is
/// visible before it takes effect.
///
/// Three properties are worth stating plainly, because they are what the rest
/// of the design protects:
///
/// Nothing here can stop a launch trading. There is no pause, blocklist or
/// fee switch that reaches a live launch. The pause that does exist gates the
/// creation of new launches and nothing else, and disabling a configuration or
/// a quote asset likewise affects only launches made afterwards.
///
/// Nothing here can reach locked liquidity. Graduation mints the position
/// directly to the locker, which has no function that could send it anywhere.
///
/// Terms a creator was shown cannot change underneath them. A configuration's
/// economics are immutable once added: a change means a new configuration with
/// a new id, so an id always means the same thing. A creator can additionally
/// pin the whole set of terms they read, and their launch reverts rather than
/// settling on different ones.
contract LaunchFactory is AccessControlDefaultAdminRules, ReentrancyGuard, ILaunchRegistry {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    /// @dev Ceiling on the protocol's base trade fee.
    uint16 public constant MAX_TRADE_FEE_BPS = 1_000;

    /// @dev Ceiling on the cap a creator's own fee can be raised to.
    uint16 public constant MAX_CREATOR_FEE_CEILING_BPS = 1_000;

    /// @dev Ceiling on what a trader can be charged in total, so the two legs
    /// can never be stacked into something confiscatory.
    uint16 public constant MAX_TOTAL_FEE_BPS = 2_000;

    /// @dev Ceiling on the protocol's share of the trade fee. Below half, so a
    /// policy change can never leave the creator with nothing.
    uint16 public constant MAX_TREASURY_SHARE_BPS = 5_000;

    /// @dev Ceiling on the opening tax. Below the whole trade, so even the
    /// first buy of a launch nets its buyer something.
    uint256 public constant MAX_OPENING_TAX_START_BPS = 9_900;

    /// @dev Ceiling on the opening-tax window. Long enough to cover several
    /// blocks of bot activity, short enough that a misconfiguration cannot
    /// close a launch to the public for minutes.
    uint256 public constant MAX_OPENING_TAX_WINDOW = 60;

    /// @dev Ceiling on how much of the supply tax-exempt wallets may buy, in
    /// total, while the opening window is open.
    uint256 public constant MAX_OPENING_EXEMPT_CAP_BPS = 2_500;

    /// @dev Bound on the creator-declared exemption list.
    uint256 public constant MAX_EXEMPTIONS = 32;

    /// @dev Smallest supply a configuration may declare.
    uint256 public constant MIN_SUPPLY = 1e18;

    /// @dev Coarser quote assets than this let a trader split an order into
    /// pieces whose fee rounds to zero.
    uint8 public constant MIN_QUOTE_DECIMALS = 6;

    /// @dev Notice a protocol-proposed fee recipient change must serve before
    /// it can be executed, and how long it stays executable afterwards.
    uint256 public constant FEE_RECIPIENT_TIMELOCK = 3 days;
    uint256 public constant FEE_RECIPIENT_WINDOW = 3 days;

    /// @dev How long a launch must sit settled before its reserves may be
    /// returned by hand. Listing stays permissionless throughout the wait, so
    /// anyone can end it early and permanently with one call.
    uint256 public constant RESCUE_DELAY = 7 days;

    /// @notice Sets launch configurations, fee terms, caps and the venue.
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    /// @notice Approves quote assets and their curve economics.
    bytes32 public constant ASSET_ROLE = keccak256("ASSET_ROLE");

    /// @notice Runs the recovery paths, and gates new launches.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    error AlreadySet();
    error ZeroAddress();
    error NotWhitelisted();
    error LaunchFeeNotPaid(uint256 sent, uint256 expected);
    error InvalidParams();
    error InvalidConfig();
    error ConfigDisabled();
    error UnknownConfig();
    error InvalidBps();
    error CreatorFeeTooHigh(uint16 requested, uint16 cap);
    error TotalFeeTooHigh();
    error SupplyTooLow();
    error QuoteAssetNotApproved(address asset);
    error QuoteAssetTermsMissing(address asset);
    error QuoteAssetDecimalsMismatch(uint8 expected, uint8 actual);
    error EconomicsChanged(bytes32 expected, bytes32 actual);
    error ExemptionListTooLong();
    error UnknownLaunch();
    error WrongPhase();
    error NotFeeRecipient();
    error NotBuybackController();
    error NoPendingChange();
    error TimelockNotElapsed(uint256 effectiveAt);
    error TimelockExpired(uint256 expiresAt);
    error NothingToList();
    error RescueTooEarly(uint256 availableAt);
    error SeedStillViable();
    error NotForwarder();
    error InexactTransfer(address asset, uint256 expected, uint256 received);
    error DependenciesNotWired();

    event LaunchCreated(
        address indexed token,
        address indexed curve,
        address indexed creator,
        address quote,
        uint256 configId,
        uint256 graduationTarget
    );
    event LaunchSettled(address indexed token, uint256 quoteAmount, uint256 tokenAmount);
    event LaunchForceSettled(address indexed token);
    event LaunchListed(
        address indexed token, address pool, uint256 positionId, uint256 tokenAmount, uint256 quoteAmount
    );
    event SupplyPermanentlyLocked(address indexed token, uint256 amount);
    event LaunchRefunded(address indexed token, address indexed recipient, uint256 quoteAmount, uint256 tokenAmount);
    event FeeRecipientUpdated(address indexed token, address indexed previous, address indexed current);
    event FeeRecipientChangeProposed(
        address indexed token, address indexed current, address indexed proposed, uint256 effectiveAt, uint256 expiresAt
    );
    event FeeRecipientChangeCancelled(address indexed token, address indexed proposed);
    event BuybackEnabledUpdated(address indexed token, bool enabled, address indexed caller);
    event LaunchConfigAdded(uint256 indexed configId, LaunchConfig config);
    event LaunchConfigEnabledUpdated(uint256 indexed configId, bool enabled);
    event QuoteAssetTermsUpdated(address indexed asset, uint256 virtualQuote, uint256 graduationTarget, uint8 decimals);
    event QuoteAssetApprovalUpdated(address indexed asset, bool approved);
    event FeePolicyUpdated(FeePolicy policy);
    event LaunchFeeUpdated(uint256 launchFee);
    event LaunchEnabledUpdated(bool enabled);
    event WhitelistUpdated(address indexed account, bool allowed);
    event MaxCreatorFeeUpdated(uint16 bps);
    event OpeningTaxUpdated(uint256 startBps, uint256 window, uint256 exemptCapBps);
    event ListingRemainderHandled(address indexed token, uint256 tokensLocked, uint256 quoteToTreasury);
    event VenueUpdated(address venue);
    event FeeSweepOperatorUpdated(address operator);
    event ForwarderUpdated(address forwarder);
    event DependenciesWired(address deployer, address feeCollector);

    struct PendingFeeRecipient {
        address recipient;
        uint64 effectiveAt;
        uint64 expiresAt;
    }

    /// @notice Pull-payment ledger every payout is credited to.
    IFeeEscrow public immutable escrow;

    /// @notice Vault bought-back supply vests in.
    IBuybackVault public immutable buybackVault;

    /// @notice Permanent custody of graduated liquidity.
    ILiquidityLocker public immutable locker;

    /// @notice Deploys each launch's curve and token. Wired once after
    /// deployment, because its constructor needs this factory's address.
    ILaunchDeployer public launchDeployer;

    /// @notice Splits fees that accrue after graduation. Wired once, for the
    /// same reason.
    address public feeCollector;

    /// @notice AMM new launches graduate into.
    address public venue;

    /// @notice Router permitted to launch on another account's behalf.
    address public forwarder;

    /// @notice Address allowed to run price-sensitive fee sweeps.
    address public feeSweepOperator;

    /// @notice Fee split and conversion bounds new launches snapshot.
    FeePolicy public feePolicy;

    /// @notice Flat fee charged for creating a launch.
    uint256 public launchFee;

    /// @notice Whether anyone may create a launch. While false, only
    /// whitelisted accounts can.
    bool public launchEnabled;

    /// @notice Cap a creator's own fee is checked against at creation.
    uint16 public maxCreatorFeeBps = 1_000;

    /// @notice Opening tax in the launch second, in bps of a buy.
    uint256 public openingTaxStartBps = 9_900;

    /// @notice Seconds across which the opening tax decays to zero.
    uint256 public openingTaxWindow = 5;

    /// @notice Share of supply, in bps, that tax-exempt wallets may buy in
    /// total while the opening window is open.
    uint256 public openingExemptCapBps = 1_000;

    mapping(address account => bool allowed) public whitelisted;
    mapping(address asset => bool approved) public approvedQuoteAssets;
    mapping(address asset => QuoteAssetTerms terms) private _quoteAssetTerms;
    mapping(address token => Launch launch) private _launches;
    mapping(address token => FeePolicy policy) private _launchPolicies;
    mapping(address token => PendingFeeRecipient) public pendingFeeRecipient;
    mapping(address creator => address[] tokens) private _launchesByCreator;

    LaunchConfig[] private _configs;
    address[] private _allLaunches;

    /// @param admin Receives the admin role, which grants every other role.
    /// @param adminTransferDelay Notice an admin handover must serve.
    constructor(
        address admin,
        uint48 adminTransferDelay,
        IFeeEscrow escrow_,
        IBuybackVault buybackVault_,
        ILiquidityLocker locker_,
        address venue_,
        address treasury_,
        uint256 launchFee_
    ) AccessControlDefaultAdminRules(adminTransferDelay, admin) {
        if (address(escrow_) == address(0) || address(buybackVault_) == address(0)) revert ZeroAddress();
        if (address(locker_) == address(0) || venue_ == address(0) || treasury_ == address(0)) revert ZeroAddress();

        escrow = escrow_;
        buybackVault = buybackVault_;
        locker = locker_;
        venue = venue_;
        launchFee = launchFee_;
        feeSweepOperator = admin;
        feePolicy =
            FeePolicy({treasury: treasury_, treasuryShareBps: 3_000, buybackShareBps: 5_000, maxPriceImpactBps: 300});

        _grantRole(CONFIG_ROLE, admin);
        _grantRole(ASSET_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    // --- Wiring ----------------------------------------------------------

    /// @notice Wires the two helpers whose constructors need this address.
    /// @dev One call, once. Launching is impossible until it has happened.
    function wire(ILaunchDeployer deployer_, address feeCollector_) external onlyRole(CONFIG_ROLE) {
        if (address(launchDeployer) != address(0)) revert AlreadySet();
        if (address(deployer_) == address(0) || feeCollector_ == address(0)) revert ZeroAddress();
        if (deployer_.factory() != address(this)) revert DependenciesNotWired();

        launchDeployer = deployer_;
        feeCollector = feeCollector_;
        emit DependenciesWired(address(deployer_), feeCollector_);
    }

    // --- Configuration ---------------------------------------------------

    /// @notice Adds a launch configuration.
    /// @dev Configurations are append-only and their economics are immutable:
    /// there is no function that edits one. A change in terms therefore means a
    /// new id, which is what lets an integrator treat an id as a stable
    /// description of what a launch will be. Only the flag that decides whether
    /// new launches may still select it can move.
    function addLaunchConfig(LaunchConfig calldata config) external onlyRole(CONFIG_ROLE) returns (uint256 configId) {
        _validateConfig(config);
        // A fee tier the venue does not support, or one paired with the wrong
        // spacing, would make every graduation on this configuration fail.
        // Caught here, before a single launch can be created against it.
        ILiquidityVenue(venue).checkFeeTier(config.venueFee, config.tickSpacing);
        configId = _configs.length;
        _configs.push(config);
        emit LaunchConfigAdded(configId, config);
    }

    /// @notice Opens or closes a configuration to new launches.
    function setLaunchConfigEnabled(uint256 configId, bool enabled) external onlyRole(CONFIG_ROLE) {
        if (configId >= _configs.length) revert UnknownConfig();
        _configs[configId].enabled = enabled;
        emit LaunchConfigEnabledUpdated(configId, enabled);
    }

    /// @notice Records the curve economics launches against `asset` will use,
    /// in that asset's own decimals.
    /// @dev Required before an asset can be approved. A virtual reserve is a
    /// quantity of the quote asset and only means anything against its scale:
    /// reusing an eighteen-decimal figure on a six-decimal stablecoin would
    /// misprice the curve by twelve orders of magnitude, silently. The caller
    /// states the scale they sized against and the asset's own report must
    /// agree.
    function setQuoteAssetTerms(address asset, uint256 virtualQuote, uint256 graduationTarget, uint8 decimals)
        external
        onlyRole(ASSET_ROLE)
    {
        if (asset == address(0) || virtualQuote == 0 || graduationTarget == 0) revert InvalidParams();
        if (decimals < MIN_QUOTE_DECIMALS) revert InvalidParams();
        _checkDecimals(asset, decimals, false);

        _quoteAssetTerms[asset] =
            QuoteAssetTerms({virtualQuote: virtualQuote, graduationTarget: graduationTarget, decimals: decimals});
        emit QuoteAssetTermsUpdated(asset, virtualQuote, graduationTarget, decimals);
    }

    /// @notice Approves or withdraws an ERC-20 quote asset for new launches.
    /// @dev Withdrawing approval has no effect on launches already trading
    /// against the asset. The scale is re-checked here because approval is the
    /// point the asset enters service, and the only point its address is
    /// certain to hold code.
    function setQuoteAssetApproved(address asset, bool approved) external onlyRole(ASSET_ROLE) {
        if (asset == address(0)) revert InvalidParams();
        if (approved) {
            if (asset.code.length == 0) revert InvalidParams();
            QuoteAssetTerms memory terms = _quoteAssetTerms[asset];
            if (terms.virtualQuote == 0 || terms.graduationTarget == 0) revert QuoteAssetTermsMissing(asset);
            _checkDecimals(asset, terms.decimals, true);
        }
        approvedQuoteAssets[asset] = approved;
        emit QuoteAssetApprovalUpdated(asset, approved);
    }

    /// @notice Sets the fee split new launches snapshot.
    /// @dev Launches already created keep the policy they recorded, so this
    /// governs future launches only.
    function setFeePolicy(FeePolicy calldata policy) external onlyRole(CONFIG_ROLE) {
        if (policy.treasury == address(0)) revert ZeroAddress();
        if (policy.treasuryShareBps > MAX_TREASURY_SHARE_BPS || policy.buybackShareBps > BPS) revert InvalidBps();
        if (policy.maxPriceImpactBps == 0 || policy.maxPriceImpactBps >= BPS) revert InvalidBps();
        feePolicy = policy;
        emit FeePolicyUpdated(policy);
    }

    /// @notice Sets the flat launch fee.
    function setLaunchFee(uint256 newFee) external onlyRole(CONFIG_ROLE) {
        launchFee = newFee;
        emit LaunchFeeUpdated(newFee);
    }

    /// @notice Opens or closes launch creation to accounts that are not whitelisted.
    /// @dev This gates creation only. It cannot touch a launch that exists.
    function setLaunchEnabled(bool enabled) external onlyRole(GUARDIAN_ROLE) {
        launchEnabled = enabled;
        emit LaunchEnabledUpdated(enabled);
    }

    /// @notice Grants or revokes the right to launch while creation is closed.
    function setWhitelisted(address account, bool allowed) external onlyRole(GUARDIAN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        whitelisted[account] = allowed;
        emit WhitelistUpdated(account, allowed);
    }

    /// @notice Sets the cap a creator's own fee is checked against.
    /// @dev Launches keep the fee they were created with regardless.
    function setMaxCreatorFeeBps(uint16 bps) external onlyRole(CONFIG_ROLE) {
        if (bps > MAX_CREATOR_FEE_CEILING_BPS) revert InvalidBps();
        maxCreatorFeeBps = bps;
        emit MaxCreatorFeeUpdated(bps);
    }

    /// @notice Sets the opening tax new launches snapshot.
    /// @dev A launch already trading keeps the terms it opened under, so a
    /// retune can never reprice a window that is already running. Zero disables
    /// the tax for launches created while it is zero. A non-zero rate must
    /// exceed the ordinary combined fee ceiling, so the opening window always
    /// dominates the normal cost of trading. `exemptCapBps` bounds how much of
    /// the supply the creator and their declared wallets may take untaxed
    /// before the window closes.
    function setOpeningTax(uint256 startBps, uint256 window, uint256 exemptCapBps) external onlyRole(CONFIG_ROLE) {
        if (startBps != 0 && (startBps <= MAX_TOTAL_FEE_BPS || startBps > MAX_OPENING_TAX_START_BPS)) {
            revert InvalidBps();
        }
        if (window == 0 || window > MAX_OPENING_TAX_WINDOW) revert InvalidParams();
        if (exemptCapBps > MAX_OPENING_EXEMPT_CAP_BPS) revert InvalidBps();
        openingTaxStartBps = startBps;
        openingTaxWindow = window;
        openingExemptCapBps = exemptCapBps;
        emit OpeningTaxUpdated(startBps, window, exemptCapBps);
    }

    /// @notice Sets the AMM new launches graduate into.
    /// @dev Each launch records its venue at creation, so this never moves a
    /// launch that already exists.
    function setVenue(address venue_) external onlyRole(CONFIG_ROLE) {
        if (venue_ == address(0)) revert ZeroAddress();
        venue = venue_;
        emit VenueUpdated(venue_);
    }

    /// @notice Sets the address allowed to run price-sensitive fee sweeps.
    function setFeeSweepOperator(address operator) external onlyRole(CONFIG_ROLE) {
        if (operator == address(0)) revert ZeroAddress();
        feeSweepOperator = operator;
        emit FeeSweepOperatorUpdated(operator);
    }

    /// @notice Sets the router allowed to preserve its own caller as the creator.
    /// @dev Kept separate from the whitelist: that list decides who may launch,
    /// whereas this address is trusted to name another account. Using the
    /// transaction origin for that instead would break under account
    /// abstraction and must never gate authority.
    function setForwarder(address forwarder_) external onlyRole(CONFIG_ROLE) {
        if (forwarder_ == address(0)) revert ZeroAddress();
        forwarder = forwarder_;
        emit ForwarderUpdated(forwarder_);
    }

    // --- Reads -----------------------------------------------------------

    /// @notice Number of launch configurations ever added.
    function launchConfigCount() external view returns (uint256) {
        return _configs.length;
    }

    /// @notice One launch configuration.
    function getLaunchConfig(uint256 configId) external view returns (LaunchConfig memory) {
        if (configId >= _configs.length) revert UnknownConfig();
        return _configs[configId];
    }

    /// @notice Curve economics recorded for an ERC-20 quote asset.
    function quoteAssetTerms(address asset) external view returns (QuoteAssetTerms memory) {
        return _quoteAssetTerms[asset];
    }

    /// @notice The protocol's record of one launch.
    function getLaunch(address token) external view returns (Launch memory) {
        return _launches[token];
    }

    /// @notice The fee split frozen for one launch.
    function getFeePolicy(address token) external view returns (FeePolicy memory) {
        return _launchPolicies[token];
    }

    /// @notice Total launches ever created.
    function launchCount() external view returns (uint256) {
        return _allLaunches.length;
    }

    /// @notice One launch by index, newest last.
    /// @dev The protocol keeps its own enumerable registry so an interface or
    /// indexer can reconstruct every launch from the chain alone, without
    /// replaying logs and without depending on anybody's hosted service.
    function launchAt(uint256 index) external view returns (address) {
        return _allLaunches[index];
    }

    /// @notice Number of launches created by `creator`.
    function launchCountOf(address creator) external view returns (uint256) {
        return _launchesByCreator[creator].length;
    }

    /// @notice `creator`'s launch at `index`, oldest first.
    /// @dev Paged reads over both lists live in `LaunchLens`, which keeps this
    /// contract's deployed code within its size limit.
    function launchOfAt(address creator, uint256 index) external view returns (address) {
        return _launchesByCreator[creator][index];
    }

    /// @notice Whether `account` may create a launch right now.
    /// @dev The single predicate a creation flow should check, rather than
    /// reading the gate and the whitelist separately.
    function canLaunch(address account) public view returns (bool) {
        return launchEnabled || whitelisted[account];
    }

    /// @notice Digest of every protocol-set term a launch of `configId` in
    /// `quote` would be created on right now.
    /// @dev Read it immediately before launching and pass it back as
    /// `expectedEconomics`. It spans the curve's shape and cost, the pool the
    /// launch graduates into, the venue, and the fee split that follows,
    /// because narrowing it to the reserve and target alone would let the
    /// supply, the trade fee or the pool's own fee tier move underneath a
    /// pinned launch. The opening-tax terms and the launch fee are included
    /// for the same reason. The creator's own fee is deliberately absent: it is
    /// a value they supply, so a cap change makes the launch revert on its own
    /// rather than silently reprice.
    function previewEconomics(uint256 configId, address quote) external view returns (bytes32) {
        if (configId >= _configs.length) revert UnknownConfig();
        LaunchConfig memory config = _configs[configId];
        (uint256 virtualQuote, uint256 target) = _economicsFor(config, quote);
        return _economicsDigest(config, feePolicy, virtualQuote, target, venue);
    }

    // --- Launching -------------------------------------------------------

    /// @notice Creates a launch. Trading opens immediately on its curve.
    /// @dev The caller and their fee recipient are exempted from the opening
    /// tax automatically, so a solo creator needs nothing further.
    function launch(LaunchParams calldata params, uint256 configId, address quote)
        external
        payable
        nonReentrant
        returns (address token, address curve)
    {
        return _launch(params, configId, quote, msg.sender);
    }

    /// @notice Creates a launch and exempts further wallets from the opening tax.
    /// @dev The sanctioned path for a team bundling its opening buys across
    /// several addresses: declared wallets clear at the untaxed price while
    /// undeclared bots in the same seconds pay the decaying tax.
    function launch(
        LaunchParams calldata params,
        uint256 configId,
        address quote,
        address[] calldata taxExemptions
    ) external payable nonReentrant returns (address token, address curve) {
        (token, curve) = _launch(params, configId, quote, msg.sender);
        _applyExemptions(curve, taxExemptions);
    }

    /// @notice Creates a launch on behalf of the trusted router's own caller.
    /// @dev Only the configured forwarder may name a creator. This preserves
    /// the real account for address namespacing and attribution without using
    /// the transaction origin, which must never be relied on for authority.
    function launchFor(
        LaunchParams calldata params,
        uint256 configId,
        address quote,
        address creator,
        address[] calldata taxExemptions
    ) external payable nonReentrant returns (address token, address curve) {
        if (msg.sender != forwarder) revert NotForwarder();
        (token, curve) = _launch(params, configId, quote, creator);
        _applyExemptions(curve, taxExemptions);
    }

    // --- Graduation ------------------------------------------------------

    /// @notice Closes a finished curve, takes its reserves, and lists it.
    /// @dev Called automatically by the buy that finishes a curve, and callable
    /// by anyone afterwards. Settlement and listing are separate steps on
    /// purpose: settlement only moves balances between the protocol's own
    /// contracts, so it is safe to run inside somebody's trade, whereas listing
    /// touches an external AMM and can fail for reasons outside this
    /// protocol's control. Listing is attempted here so the ordinary path
    /// completes in one transaction, and if it does not succeed the launch
    /// simply waits in the settled phase for anyone to call `list`.
    function graduate(address token) external nonReentrant {
        Launch storage record = _launches[token];
        if (!record.exists) revert UnknownLaunch();
        if (record.phase != Phase.Curve) revert WrongPhase();

        BondingCurve curve = BondingCurve(payable(record.curve));
        _assertSeedable(record, curve.realQuoteReserve(), curve.trackedTokens());
        _settle(token, record, curve);

        try this.list(token) {} catch {}
    }

    /// @notice Settles a curve whose seed the venue will not accept.
    /// @dev The preflight in `graduate` runs before settlement, so a launch it
    /// refuses stays on its curve. But the curve has already closed its sell
    /// side by then, and the refund path only applies to a settled launch, so
    /// without this the reserves would have no exit at all. It is restricted to
    /// launches the preflight genuinely refuses: while a seed is viable anyone
    /// can call `graduate` and this reverts, so it cannot be used to take a
    /// healthy launch's reserves instead of listing it. The refund wait still
    /// runs from the settlement recorded here.
    function forceSettle(address token) external onlyRole(GUARDIAN_ROLE) nonReentrant {
        Launch storage record = _launches[token];
        if (!record.exists) revert UnknownLaunch();
        if (record.phase != Phase.Curve) revert WrongPhase();

        BondingCurve curve = BondingCurve(payable(record.curve));
        if (_seedable(record, curve.realQuoteReserve(), curve.trackedTokens())) revert SeedStillViable();

        _settle(token, record, curve);
        emit LaunchForceSettled(token);
    }

    /// @notice Creates the pool, seeds it, and locks the position forever.
    /// @dev Permissionless and retryable: a launch stays settled until a seed
    /// succeeds, so a transient failure can never strand reserves. Every state
    /// change happens before the external calls, so a failed attempt leaves the
    /// launch exactly as it was and the next attempt starts clean.
    function list(address token) public returns (uint256 positionId) {
        Launch storage record = _launches[token];
        if (!record.exists) revert UnknownLaunch();
        if (record.phase != Phase.Settled) revert WrongPhase();

        uint256 quoteAmount = record.settledQuote;
        uint256 settledTokens = record.settledTokens;
        uint256 tokenAmount = _listingTokens(record, quoteAmount, settledTokens);
        _assertSeedable(record, quoteAmount, settledTokens);

        record.settledQuote = 0;
        record.settledTokens = 0;
        record.settledAt = 0;
        record.phase = Phase.Listed;

        uint256 excess = settledTokens - tokenAmount;
        if (excess != 0) {
            IERC20(token).forceApprove(address(locker), excess);
            locker.lockSupply(token, excess);
            IERC20(token).forceApprove(address(locker), 0);
            emit SupplyPermanentlyLocked(token, excess);
        }

        address pool;
        (positionId, pool) = _seedPool(token, record, tokenAmount, quoteAmount);
        locker.lockPosition(token, positionId, record.venue);

        emit LaunchListed(token, pool, positionId, tokenAmount, quoteAmount);
    }

    /// @notice Returns a settled launch's reserves when its pool can never be
    /// seeded.
    /// @dev The one path by which value held here can leave without becoming
    /// locked liquidity, and it is deliberately hard to reach. Settlement
    /// credits whatever it actually received, so it tolerates a quote asset
    /// that under-delivers, but seeding requires the full amount. An asset
    /// that becomes fee-taking, rebasing or blocking after approval therefore
    /// leaves a launch whose curve is shut and whose pool can never open.
    ///
    /// What makes the wait meaningful is that listing stays permissionless
    /// throughout it: any holder can end the window early, and permanently,
    /// with one call to `list`. Reserves remain reachable by this path only if
    /// nobody could list them. The launch is marked refunded forever
    /// afterwards, so the exception is visible rather than quiet.
    function refundSettled(address token, address recipient) external onlyRole(GUARDIAN_ROLE) nonReentrant {
        Launch storage record = _launches[token];
        if (!record.exists) revert UnknownLaunch();
        if (record.phase != Phase.Settled) revert WrongPhase();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 availableAt = record.settledAt + RESCUE_DELAY;
        if (block.timestamp < availableAt) revert RescueTooEarly(availableAt);

        uint256 quoteAmount = record.settledQuote;
        uint256 tokenAmount = record.settledTokens;
        record.settledQuote = 0;
        record.settledTokens = 0;
        record.settledAt = 0;
        record.phase = Phase.Refunded;

        // Deliberately not an exact-delivery transfer: the asset's inability to
        // deliver exactly is the reason this path exists.
        if (quoteAmount != 0) _payOut(record.quote, recipient, quoteAmount);
        if (tokenAmount != 0) IERC20(token).safeTransfer(recipient, tokenAmount);

        emit LaunchRefunded(token, recipient, quoteAmount, tokenAmount);
    }

    /// @notice Pays a still-trading launch's pending fees directly, bypassing
    /// the escrow, when its quote asset has stopped delivering there.
    /// @dev Also the only way to unwedge such a launch's graduation, because
    /// settlement sweeps fees before handing over reserves and cannot succeed
    /// while that sweep reverts.
    function rescueCurveFees(address token) external onlyRole(GUARDIAN_ROLE) nonReentrant {
        Launch storage record = _launches[token];
        if (!record.exists) revert UnknownLaunch();
        BondingCurve(payable(record.curve)).rescueFees();
    }

    // --- Creator controls ------------------------------------------------

    /// @notice Points a launch's future fees at a new address.
    /// @dev Callable only by the current recipient, takes effect at once, and
    /// moves the buyback vest's beneficiary with it. It does not move balances
    /// already credited, so those should be claimed first. A pending protocol
    /// proposal is deliberately not cancelled by this: see
    /// `proposeFeeRecipient`.
    function transferFeeRecipient(address token, address newRecipient) external {
        Launch storage record = _launches[token];
        if (!record.exists) revert UnknownLaunch();
        if (msg.sender != record.feeRecipient) revert NotFeeRecipient();
        _setFeeRecipient(token, record, newRecipient);
    }

    /// @notice Turns a launch's buyback route on or off.
    /// @dev Only the creator may switch it on, because the buyback is funded
    /// from their own share of the fee. The protocol may only switch it off,
    /// which is strictly favourable to the creator, so nobody can force a
    /// creator's fees into the vest to capture the protocol's share of it.
    function setBuybackEnabled(address token, bool enabled) external {
        Launch storage record = _launches[token];
        if (!record.exists) revert UnknownLaunch();
        bool isCreator = msg.sender == record.feeRecipient;
        bool isProtocol = hasRole(CONFIG_ROLE, msg.sender);
        if (!isCreator && !isProtocol) revert NotBuybackController();
        if (enabled && !isCreator) revert NotBuybackController();

        record.buybackEnabled = enabled;
        if (record.phase == Phase.Curve) {
            BondingCurve(payable(record.curve)).setBuybackEnabled(enabled);
        }
        emit BuybackEnabledUpdated(token, enabled, msg.sender);
    }

    /// @notice Proposes a protocol override of a launch's fee recipient.
    /// @dev Its motivating case is a creator who has lost access to their
    /// wallet, and the power is deliberately not conditioned on that, so it
    /// should be read as a standing protocol power over fee routing rather
    /// than a narrow recovery. What bounds it is notice: nothing happens for
    /// the timelock, the proposal states both the new address and the date from
    /// the moment it is made, and it expires if nobody executes it. Holders
    /// therefore learn of a takeover before it happens, and the wait is their
    /// window to act.
    ///
    /// A creator moving their fees during the wait does not cancel the
    /// proposal. That is intentional: otherwise whoever had stolen a creator's
    /// wallet could sidestep the very recovery proposed because it was stolen.
    function proposeFeeRecipient(address token, address newRecipient) external onlyRole(GUARDIAN_ROLE) {
        Launch storage record = _launches[token];
        if (!record.exists) revert UnknownLaunch();
        if (newRecipient == address(0)) revert ZeroAddress();

        uint64 effectiveAt = uint64(block.timestamp + FEE_RECIPIENT_TIMELOCK);
        uint64 expiresAt = effectiveAt + uint64(FEE_RECIPIENT_WINDOW);
        pendingFeeRecipient[token] =
            PendingFeeRecipient({recipient: newRecipient, effectiveAt: effectiveAt, expiresAt: expiresAt});

        emit FeeRecipientChangeProposed(token, record.feeRecipient, newRecipient, effectiveAt, expiresAt);
    }

    /// @notice Executes a matured proposal. Permissionless by design, so the
    /// protocol cannot quietly sit on one it has already announced.
    function executeFeeRecipientChange(address token) external {
        PendingFeeRecipient memory pending = pendingFeeRecipient[token];
        if (pending.recipient == address(0)) revert NoPendingChange();
        if (block.timestamp < pending.effectiveAt) revert TimelockNotElapsed(pending.effectiveAt);
        if (block.timestamp > pending.expiresAt) revert TimelockExpired(pending.expiresAt);

        Launch storage record = _launches[token];
        delete pendingFeeRecipient[token];
        _setFeeRecipient(token, record, pending.recipient);
    }

    /// @notice Calls off a proposal before it takes effect.
    function cancelFeeRecipientChange(address token) external onlyRole(GUARDIAN_ROLE) {
        PendingFeeRecipient memory pending = pendingFeeRecipient[token];
        if (pending.recipient == address(0)) revert NoPendingChange();
        delete pendingFeeRecipient[token];
        emit FeeRecipientChangeCancelled(token, pending.recipient);
    }

    // --- Internals -------------------------------------------------------

    function _launch(LaunchParams calldata params, uint256 configId, address quote, address creator)
        private
        returns (address token, address curve)
    {
        if (address(launchDeployer) == address(0)) revert DependenciesNotWired();
        if (!canLaunch(creator)) revert NotWhitelisted();
        if (msg.value != launchFee) revert LaunchFeeNotPaid(msg.value, launchFee);
        if (configId >= _configs.length) revert UnknownConfig();
        if (bytes(params.name).length == 0 || bytes(params.symbol).length == 0) revert InvalidParams();
        if (params.creatorFeeBps > maxCreatorFeeBps) revert CreatorFeeTooHigh(params.creatorFeeBps, maxCreatorFeeBps);

        LaunchConfig memory config = _configs[configId];
        if (!config.enabled) revert ConfigDisabled();
        if (uint256(config.tradeFeeBps) + params.creatorFeeBps > MAX_TOTAL_FEE_BPS) revert TotalFeeTooHigh();

        if (quote != address(0)) {
            if (!approvedQuoteAssets[quote]) revert QuoteAssetNotApproved(quote);
            // The scale was verified at approval, but an upgradeable asset can
            // change it afterwards and this curve prices against the recorded
            // figure for its whole life.
            _checkDecimals(quote, _quoteAssetTerms[quote].decimals, true);
        }

        FeePolicy memory policy = feePolicy;
        address venue_ = venue;
        (uint256 virtualQuote, uint256 target) = _economicsFor(config, quote);

        if (params.expectedEconomics != bytes32(0)) {
            bytes32 actual = _economicsDigest(config, policy, virtualQuote, target, venue_);
            if (params.expectedEconomics != actual) revert EconomicsChanged(params.expectedEconomics, actual);
        }

        // A configuration and a quote asset are validated separately but
        // graduate as a pair, and it is the pair that fixes the seed. Terms
        // implying a position the venue would refuse are rejected here, while
        // nothing has been deployed and the creator still has their fee.
        _assertTermsSeedable(config, virtualQuote, target, quote, venue_);

        address feeRecipient = params.feeRecipient == address(0) ? creator : params.feeRecipient;

        (token, curve) = launchDeployer.deploy(
            ILaunchDeployer.Deployment({
                quote: quote,
                feeRecipient: feeRecipient,
                creator: creator,
                policy: policy,
                escrow: address(escrow),
                buybackVault: address(buybackVault),
                virtualQuote: virtualQuote,
                graduationTarget: target,
                supply: config.supply,
                tradeFeeBps: config.tradeFeeBps,
                creatorFeeBps: params.creatorFeeBps,
                buybackEnabled: params.buybackEnabled,
                salt: params.salt,
                params: params
            })
        );

        BondingCurve(payable(curve)).initialize(token);

        // The creator is never a sniper on their own launch: an opening buy
        // lands in the launch second, exactly when the tax peaks.
        BondingCurve(payable(curve)).exemptFromOpeningTax(creator);
        if (feeRecipient != creator) BondingCurve(payable(curve)).exemptFromOpeningTax(feeRecipient);

        _launches[token] = Launch({
            token: token,
            curve: curve,
            creator: creator,
            feeRecipient: feeRecipient,
            quote: quote,
            venue: venue_,
            graduationTarget: target,
            venueFee: config.venueFee,
            tickSpacing: config.tickSpacing,
            creatorFeeBps: params.creatorFeeBps,
            buybackEnabled: params.buybackEnabled,
            phase: Phase.Curve,
            settledQuote: 0,
            settledTokens: 0,
            settledAt: 0,
            exists: true
        });
        _launchPolicies[token] = policy;
        _allLaunches.push(token);
        _launchesByCreator[creator].push(token);

        // Last, once the launch is fully recorded: this forwards value to the
        // treasury, which may be a contract that calls back in.
        _payLaunchFee(policy.treasury);

        emit LaunchCreated(token, curve, creator, quote, configId, target);
    }

    function _applyExemptions(address curve, address[] calldata taxExemptions) private {
        if (taxExemptions.length > MAX_EXEMPTIONS) revert ExemptionListTooLong();
        for (uint256 i = 0; i < taxExemptions.length; ++i) {
            BondingCurve(payable(curve)).exemptFromOpeningTax(taxExemptions[i]);
        }
    }

    /// @dev Takes a finished curve's reserves and records the settled phase.
    /// Shared by the ordinary path and the forced one, which differ only in the
    /// preflight that precedes them.
    function _settle(address token, Launch storage record, BondingCurve curve) private {
        // Record what this contract actually received rather than what the
        // curve reported sending. An asset that under-delivers would otherwise
        // leave the launch claiming a balance it never got, and the shortfall
        // would be drawn from whatever other launches hold the same asset here.
        uint256 before = _heldQuote(record.quote);
        (, uint256 tokenOut) = curve.settle(address(this));
        uint256 quoteOut = _heldQuote(record.quote) - before;
        if (quoteOut == 0 || tokenOut == 0) revert NothingToList();

        record.settledQuote = quoteOut;
        record.settledTokens = tokenOut;
        record.settledAt = uint64(block.timestamp);
        record.phase = Phase.Settled;

        emit LaunchSettled(token, quoteOut, tokenOut);
    }

    function _seedPool(address token, Launch storage record, uint256 tokenAmount, uint256 quoteAmount)
        private
        returns (uint256 positionId, address pool)
    {
        address venue_ = record.venue;
        address quote = record.quote;

        // Balances are measured around the venue call so that whatever it
        // returns can be accounted for exactly. Both are held for many launches
        // at once, so only the change across this call belongs to this one.
        uint256 tokensHeld = IERC20(token).balanceOf(address(this));
        uint256 quoteHeld = _heldQuote(quote);

        IERC20(token).forceApprove(venue_, tokenAmount);
        uint256 nativeValue;
        if (quote == address(0)) {
            nativeValue = quoteAmount;
        } else {
            _transferExact(quote, venue_, quoteAmount);
        }

        (positionId, pool) = ILiquidityVenue(venue_).list{value: nativeValue}(
            ILiquidityVenue.Listing({
                token: token,
                quote: quote,
                fee: record.venueFee,
                tickSpacing: record.tickSpacing,
                tokenAmount: tokenAmount,
                quoteAmount: quoteAmount,
                lockTo: address(locker)
            })
        );
        IERC20(token).forceApprove(venue_, 0);

        uint256 tokensBack = IERC20(token).balanceOf(address(this)) - (tokensHeld - tokenAmount);
        uint256 quoteBack = _heldQuote(quote) - (quoteHeld - quoteAmount);
        _handleRemainder(token, quote, record, tokensBack, quoteBack);
    }

    /// @dev Disposes of what the mint did not take, so nothing a launch
    /// graduated with is left sitting in this contract. Launch tokens are
    /// locked with the rest of the supply that missed the pool, keeping the
    /// guarantee that it never enters circulation. Quote goes to the protocol's
    /// escrow balance, where it is accounted for and claimable rather than
    /// stranded.
    function _handleRemainder(
        address token,
        address quote,
        Launch storage record,
        uint256 tokensBack,
        uint256 quoteBack
    ) private {
        if (tokensBack == 0 && quoteBack == 0) return;

        if (tokensBack != 0) {
            IERC20(token).forceApprove(address(locker), tokensBack);
            locker.lockSupply(token, tokensBack);
            IERC20(token).forceApprove(address(locker), 0);
        }
        if (quoteBack != 0) {
            address treasury = _launchPolicies[record.token].treasury;
            if (quote == address(0)) {
                escrow.credit{value: quoteBack}(treasury);
            } else {
                IERC20(quote).forceApprove(address(escrow), quoteBack);
                escrow.creditToken(treasury, quote, quoteBack);
                IERC20(quote).forceApprove(address(escrow), 0);
            }
        }
        emit ListingRemainderHandled(token, tokensBack, quoteBack);
    }

    /// @dev Tokens that may enter the pool without lowering its opening price.
    function _listingTokens(Launch storage record, uint256 quoteAmount, uint256 tokenAmount)
        private
        view
        returns (uint256 listing)
    {
        if (quoteAmount == 0 || tokenAmount == 0) revert NothingToList();
        listing = CurveMath.listingTokens(tokenAmount, quoteAmount, BondingCurve(payable(record.curve)).virtualQuote());
        if (listing == 0) revert NothingToList();
    }

    function _assertSeedable(Launch storage record, uint256 quoteAmount, uint256 tokenAmount) private view {
        uint256 listing = _listingTokens(record, quoteAmount, tokenAmount);
        ILiquidityVenue(record.venue).checkSeed(
            record.token, record.quote, record.venueFee, record.tickSpacing, listing, quoteAmount
        );
    }

    function _seedable(Launch storage record, uint256 quoteAmount, uint256 tokenAmount) private view returns (bool) {
        if (quoteAmount == 0 || tokenAmount == 0) return false;
        try this.checkSeedable(record.token, quoteAmount, tokenAmount) {
            return true;
        } catch {
            return false;
        }
    }

    /// @notice Whether a seed of these reserves would be accepted. Exposed so
    /// the forced-settlement path can tell a stuck launch from a healthy one
    /// without reverting, and so an interface can warn before it happens.
    function checkSeedable(address token, uint256 quoteAmount, uint256 tokenAmount) external view {
        _assertSeedable(_launches[token], quoteAmount, tokenAmount);
    }

    /// @dev Rejects launch terms whose seed the venue would refuse. Graduation
    /// drains a fixed share of supply against a reserve the target fixes, so
    /// the seed follows from the terms rather than from how the curve is
    /// traded. Fees move the realised amount slightly, so this narrows the
    /// failure rather than removing it, and forced settlement remains the
    /// backstop for whatever it does not catch.
    function _assertTermsSeedable(
        LaunchConfig memory config,
        uint256 virtualQuote,
        uint256 target,
        address quote,
        address venue_
    ) private view {
        uint256 reserved = CurveMath.reserveFloor(config.supply, virtualQuote, target);
        uint256 listing = CurveMath.listingTokens(reserved, target, virtualQuote);
        if (listing == 0) revert NothingToList();
        // The launch token does not exist yet, so neither does the address
        // ordering the pool will use. The venue is asked about both.
        ILiquidityVenue(venue_).checkSeed(
            address(type(uint160).max), quote, config.venueFee, config.tickSpacing, listing, target
        );
        ILiquidityVenue(venue_).checkSeed(address(1), quote, config.venueFee, config.tickSpacing, listing, target);
    }

    function _setFeeRecipient(address token, Launch storage record, address newRecipient) private {
        if (newRecipient == address(0)) revert ZeroAddress();
        address previous = record.feeRecipient;
        record.feeRecipient = newRecipient;

        if (record.phase == Phase.Curve) {
            BondingCurve(payable(record.curve)).setFeeRecipient(newRecipient);
        }
        // Keep the vest's beneficiary with the live recipient, so a recovery or
        // a handover redirects vested buyback tokens too and not merely future
        // fee payments.
        buybackVault.updateCreatorRecipient(token, newRecipient);

        emit FeeRecipientUpdated(token, previous, newRecipient);
    }

    function _economicsFor(LaunchConfig memory config, address quote)
        private
        view
        returns (uint256 virtualQuote, uint256 target)
    {
        // A launch prices in whatever it collects, so an ERC-20 quote supplies
        // its own reserve and target in its own decimals rather than inheriting
        // the configuration's native-denominated pair.
        if (quote == address(0)) return (config.virtualQuote, config.graduationTarget);
        QuoteAssetTerms memory terms = _quoteAssetTerms[quote];
        return (terms.virtualQuote, terms.graduationTarget);
    }

    function _economicsDigest(
        LaunchConfig memory config,
        FeePolicy memory policy,
        uint256 virtualQuote,
        uint256 target,
        address venue_
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                virtualQuote,
                target,
                config.supply,
                config.tradeFeeBps,
                config.venueFee,
                config.tickSpacing,
                policy.treasuryShareBps,
                policy.buybackShareBps,
                policy.maxPriceImpactBps,
                venue_,
                openingTaxStartBps,
                openingTaxWindow,
                openingExemptCapBps,
                launchFee
            )
        );
    }

    function _validateConfig(LaunchConfig calldata config) private pure {
        if (config.tradeFeeBps > MAX_TRADE_FEE_BPS) revert InvalidBps();
        if (config.supply < MIN_SUPPLY) revert SupplyTooLow();
        if (config.virtualQuote == 0 || config.graduationTarget == 0) revert InvalidConfig();
        if (config.tickSpacing <= 0) revert InvalidConfig();
        // A reserve that rounds away leaves nothing to seed the pool with, and
        // one that takes the whole supply leaves nothing to sell.
        uint256 floor = CurveMath.reserveFloor(config.supply, config.virtualQuote, config.graduationTarget);
        if (floor == 0 || floor >= config.supply) revert InvalidConfig();
    }

    /// @dev Requires `asset` to report `decimals`. An address with no code yet,
    /// or one that omits the optional metadata call, is accepted on the
    /// caller's stated scale when the check is advisory, because nothing
    /// contradicts it. At approval the check is mandatory, so an address that
    /// only becomes a contract later cannot enter service on an unverified
    /// claim.
    function _checkDecimals(address asset, uint8 decimals, bool required) private view {
        if (!required && asset.code.length == 0) return;
        try IERC20Metadata(asset).decimals() returns (uint8 actual) {
            if (actual != decimals) revert QuoteAssetDecimalsMismatch(decimals, actual);
        } catch {
            if (required) revert QuoteAssetDecimalsMismatch(decimals, 0);
        }
    }

    function _heldQuote(address quote) private view returns (uint256) {
        return quote == address(0) ? address(this).balance : IERC20(quote).balanceOf(address(this));
    }

    function _payOut(address asset, address recipient, uint256 amount) private {
        if (asset == address(0)) {
            (bool sent,) = payable(recipient).call{value: amount}("");
            if (!sent) revert InexactTransfer(asset, amount, 0);
            return;
        }
        IERC20(asset).safeTransfer(recipient, amount);
    }

    /// @dev Rejects a non-exact transfer before a position can be minted
    /// against a smaller balance than its accounting expects.
    function _transferExact(address asset, address recipient, uint256 amount) private {
        uint256 before = IERC20(asset).balanceOf(recipient);
        IERC20(asset).safeTransfer(recipient, amount);
        uint256 received = IERC20(asset).balanceOf(recipient) - before;
        if (received != amount) revert InexactTransfer(asset, amount, received);
    }

    function _payLaunchFee(address treasury) private {
        if (launchFee == 0) return;
        (bool sent,) = payable(treasury).call{value: launchFee}("");
        if (!sent) revert InexactTransfer(address(0), launchFee, 0);
    }

    /// @notice Accepts the native quote a settling curve hands over, and any
    /// dust a venue returns.
    receive() external payable {}
}
