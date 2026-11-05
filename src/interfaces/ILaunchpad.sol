// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Terms the protocol fixes for a launch when it is created. Every
/// field is copied into the launch's own contracts, so a later change to the
/// live configuration governs future launches only and can never reprice a
/// launch that is already trading.
struct LaunchConfig {
    /// @dev Fixed token supply, minted in full to the launch's bonding curve.
    uint256 supply;
    /// @dev Virtual quote reserve. Never withdrawable; it only sets the price
    /// the curve opens at and, with `graduationTarget`, the share of supply
    /// reserved for the graduated pool.
    uint256 virtualQuote;
    /// @dev Real quote amount the curve must collect before it graduates.
    uint256 graduationTarget;
    /// @dev Trade fee charged on the quote leg of every curve trade, in bps.
    uint16 tradeFeeBps;
    /// @dev Fee tier of the pool the launch graduates into.
    uint24 venueFee;
    /// @dev Tick spacing of that pool.
    int24 tickSpacing;
    /// @dev Whether new launches may still select this configuration.
    bool enabled;
}

/// @notice Fee split and conversion bounds a launch snapshots at creation.
struct FeePolicy {
    /// @dev Escrow key credited with the protocol's share.
    address treasury;
    /// @dev Protocol's share of the trade fee, taken before anything else.
    uint16 treasuryShareBps;
    /// @dev Share of what remains that is spent buying the launch token back,
    /// when the creator has buybacks enabled. Funded from the creator's share.
    uint16 buybackShareBps;
    /// @dev Ceiling on how far one internal buyback may move the price it
    /// executes against. A buyback larger than this is skipped rather than
    /// forced through, and its value is paid to the creator instead.
    uint16 maxPriceImpactBps;
}

/// @notice Where a launch is, and therefore which venue a trade must route to.
enum Phase {
    /// @dev Trading on the bonding curve.
    Curve,
    /// @dev Curve closed and drained; the pool is not created yet.
    Settled,
    /// @dev Trading in the graduated pool, whose liquidity is locked forever.
    Listed,
    /// @dev Reserves were returned manually because the pool could not be
    /// seeded. Terminal and deliberately visible.
    Refunded
}

/// @notice The protocol's record of one launch.
struct Launch {
    address token;
    address curve;
    /// @dev Account that created the launch. Metadata only; confers no rights.
    address creator;
    /// @dev Receives the creator's share of fees. The creator may transfer it.
    address feeRecipient;
    /// @dev Quote asset of the whole launch. The zero address means native ETH.
    address quote;
    /// @dev AMM this launch graduates into, fixed at creation so replacing the
    /// protocol's venue never moves a launch that is already trading.
    address venue;
    uint256 graduationTarget;
    uint24 venueFee;
    int24 tickSpacing;
    /// @dev Creator's own fee, chosen at creation within the protocol cap and
    /// immutable afterwards. Paid to the creator in full.
    uint16 creatorFeeBps;
    bool buybackEnabled;
    Phase phase;
    uint256 settledQuote;
    uint256 settledTokens;
    uint64 settledAt;
    bool exists;
}

/// @notice Curve economics for one approved ERC-20 quote asset, expressed in
/// that asset's own decimals.
struct QuoteAssetTerms {
    uint256 virtualQuote;
    uint256 graduationTarget;
    uint8 decimals;
}

/// @notice Metadata and creator choices supplied with a launch.
struct LaunchParams {
    string name;
    string symbol;
    string logo;
    string description;
    string website;
    string social;
    /// @dev Zero defaults to the caller.
    address feeRecipient;
    uint16 creatorFeeBps;
    bool buybackEnabled;
    /// @dev Digest from `previewEconomics`. Zero waives the check; any other
    /// value must still match when the transaction lands, so a configuration
    /// change cannot silently reprice the launch.
    bytes32 expectedEconomics;
    /// @dev CREATE2 salt, namespaced per creator, so the curve and token
    /// addresses are known before the transaction is sent.
    bytes32 salt;
}

/// @notice Pull-payment ledger every payout is credited to. Nothing is pushed
/// to a recipient, so one recipient that cannot accept a transfer can never
/// block distribution for anybody else.
interface IFeeEscrow {
    function credit(address recipient) external payable;

    function creditToken(address recipient, address token, uint256 amount) external;

    function claim() external returns (uint256 amount);

    function claim(uint256 amount) external returns (uint256);

    function claimToken(address token) external returns (uint256 amount);

    function claimToken(address token, uint256 amount) external returns (uint256);

    function balanceOf(address recipient) external view returns (uint256);

    function balanceOfToken(address recipient, address token) external view returns (uint256);
}

/// @notice Holds bought-back supply on a long linear vest instead of burning
/// it, and releases it to the creator and the protocol on the launch's
/// recorded split.
interface IBuybackVault {
    function lock(address token, uint256 amount, address creatorRecipient, address treasury, uint16 treasuryShareBps)
        external;

    function updateCreatorRecipient(address token, address newRecipient) external;

    function releasable(address token) external view returns (uint256);
}

/// @notice The protocol's view of a launch, read by the vault and by the
/// post-graduation fee collector.
interface ILaunchRegistry {
    function getLaunch(address token) external view returns (Launch memory);

    function getFeePolicy(address token) external view returns (FeePolicy memory);
}

/// @notice What the factory needs from a bonding curve.
interface IBondingCurve {
    function token() external view returns (address);

    function quote() external view returns (address);

    function virtualQuote() external view returns (uint256);

    function graduationTarget() external view returns (uint256);

    function settled() external view returns (bool);

    function readyToGraduate() external view returns (bool);

    function realQuoteReserve() external view returns (uint256);

    function tokenReserve() external view returns (uint256);

    function sellableTokens() external view returns (uint256);

    function initialize(address token_) external;

    function exemptFromOpeningTax(address account) external;

    function setFeeRecipient(address newRecipient) external;

    function setBuybackEnabled(bool enabled) external;

    function settle(address recipient) external returns (uint256 quoteOut, uint256 tokenOut);

    function rescueFees() external returns (uint256 treasuryAmount, uint256 creatorAmount);

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);
}

/// @notice Deploys the curve and token pair for one launch.
interface ILaunchDeployer {
    struct Deployment {
        address quote;
        address feeRecipient;
        address creator;
        FeePolicy policy;
        address escrow;
        address buybackVault;
        uint256 virtualQuote;
        uint256 graduationTarget;
        uint256 supply;
        uint16 tradeFeeBps;
        uint16 creatorFeeBps;
        bool buybackEnabled;
        bytes32 salt;
        LaunchParams params;
    }

    function factory() external view returns (address);

    function deploy(Deployment calldata deployment) external returns (address token, address curve);

    function predict(Deployment calldata deployment) external view returns (address token, address curve);
}

/// @notice The automated market maker a graduated launch is listed on.
/// Swapping the venue out is how the protocol supports a different AMM: the
/// core contracts never reference a specific one.
interface ILiquidityVenue {
    struct Listing {
        address token;
        address quote;
        uint24 fee;
        int24 tickSpacing;
        uint256 tokenAmount;
        uint256 quoteAmount;
        address lockTo;
    }

    /// @notice Creates the pool, seeds it with the amounts supplied, and
    /// transfers the whole position to `lockTo`, from where it can never be
    /// withdrawn.
    function list(Listing calldata listing) external payable returns (uint256 positionId, address pool);

    /// @notice Reverts unless a seed of these amounts would be accepted.
    function checkSeed(address token, address quote, int24 tickSpacing, uint256 tokenAmount, uint256 quoteAmount)
        external
        view;

    /// @notice The ERC-721 registry that records liquidity positions. The
    /// locker reads it to confirm custody and to collect fees.
    function positionRegistry() external view returns (address);

    /// @notice The wrapped form of the chain's native asset, which is what a
    /// pool actually holds for a launch quoted in it.
    function wrappedNative() external view returns (address);

    /// @notice Sells `amountIn` of `tokenIn` for at least `minAmountOut`,
    /// pulling the input from the caller.
    function swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut);
}

/// @notice Permanent custody of every graduated position.
interface ILiquidityLocker {
    function lockPosition(address token, uint256 positionId, address venue) external;

    function lockSupply(address token, uint256 amount) external;

    function positionOf(address token) external view returns (uint256 positionId, address venue);

    function isLocked(address token) external view returns (bool);
}
