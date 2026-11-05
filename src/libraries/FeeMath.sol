// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title FeeMath
/// @notice The protocol's two fee rules: how a trade fee divides between the
/// protocol, the buyback and the creator, and how the opening tax decays.
library FeeMath {
    uint256 internal constant BPS = 10_000;

    /// @dev Number of halvings spread across the opening-tax window. Chosen so
    /// that 2^HALVINGS exceeds any permitted starting rate, which means the tax
    /// always reaches zero inside the window instead of cutting off abruptly
    /// while still meaningful.
    uint256 internal constant OPENING_TAX_HALVINGS = 14;

    /// @notice Splits a trade fee into its three legs.
    /// @dev The protocol's share comes off the whole fee first. The buyback is
    /// then carved out of what remains, so it is funded from the creator's
    /// share alone and never from the protocol's. The creator keeps the rest.
    /// @param gross Fee charged on the trade, in the quote asset.
    /// @param treasuryShareBps Protocol's share of `gross`.
    /// @param buybackShareBps Share of the creator's remainder spent on buybacks.
    /// @param buybackEnabled Whether this launch routes a slice into buybacks.
    function split(uint256 gross, uint16 treasuryShareBps, uint16 buybackShareBps, bool buybackEnabled)
        internal
        pure
        returns (uint256 treasuryAmount, uint256 buybackAmount, uint256 creatorAmount)
    {
        treasuryAmount = (gross * treasuryShareBps) / BPS;
        uint256 creatorShare = gross - treasuryAmount;
        if (buybackEnabled) {
            buybackAmount = (creatorShare * buybackShareBps) / BPS;
        }
        creatorAmount = creatorShare - buybackAmount;
    }

    /// @notice Opening tax `elapsed` seconds into a launch, in bps of a buy.
    /// @dev Starts at `startBps` in the launch second and halves at even
    /// intervals until the window closes, so it falls away fastest at the
    /// start: the moment a bot would race for is the moment the tax is
    /// highest. Integer right shifts keep it exact and cheap. Zero at and
    /// after the window, which is the ordinary case for almost every trade.
    function openingTaxBps(uint256 startBps, uint256 elapsed, uint256 window) internal pure returns (uint256) {
        if (startBps == 0 || window == 0 || elapsed >= window) return 0;
        return startBps >> ((elapsed * OPENING_TAX_HALVINGS) / window);
    }
}
