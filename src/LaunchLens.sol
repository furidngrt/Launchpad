// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BondingCurve} from "./BondingCurve.sol";
import {LaunchFactory} from "./LaunchFactory.sol";
import {Launch, Phase} from "./interfaces/ILaunchpad.sol";

/// @title LaunchLens
/// @notice Read-only views over the factory's registry, for interfaces and
/// indexers.
///
/// Nothing here holds state or authority. It exists so the factory itself can
/// keep only the minimal getters, which keeps its deployed code within the
/// size limit with room to spare, while integrators still get paged lists and
/// a launch's whole picture in one call.
contract LaunchLens {
    /// @notice A launch's record together with the figures an interface shows.
    struct LaunchView {
        Launch launch;
        uint256 quoteReserve;
        uint256 tokenReserve;
        uint256 realQuoteReserve;
        uint256 sellableTokens;
        uint256 progressBps;
        uint256 openingTaxBps;
        uint256 openingExemptRemaining;
    }

    /// @notice The factory this lens reads.
    LaunchFactory public immutable factory;

    constructor(LaunchFactory factory_) {
        factory = factory_;
    }

    /// @notice A page of all launches, oldest first from `offset`.
    function launches(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        (uint256 start, uint256 end) = _window(factory.launchCount(), offset, limit);
        page = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = factory.launchAt(i);
        }
    }

    /// @notice A page of `creator`'s launches, oldest first from `offset`.
    function launchesOf(address creator, uint256 offset, uint256 limit) external view returns (address[] memory page) {
        (uint256 start, uint256 end) = _window(factory.launchCountOf(creator), offset, limit);
        page = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = factory.launchOfAt(creator, i);
        }
    }

    /// @notice Everything an interface needs to show one launch, in one call.
    /// @param viewer Wallet the opening-tax figure is computed for.
    function launchView(address token, address viewer) external view returns (LaunchView memory info) {
        info.launch = factory.getLaunch(token);
        if (!info.launch.exists || info.launch.phase != Phase.Curve) return info;

        BondingCurve curve = BondingCurve(payable(info.launch.curve));
        (info.quoteReserve, info.tokenReserve) = curve.reserves();
        info.realQuoteReserve = curve.realQuoteReserve();
        info.sellableTokens = curve.sellableTokens();
        info.progressBps = curve.graduationProgressBps();
        info.openingTaxBps = curve.openingTaxBps(viewer);
        info.openingExemptRemaining = curve.openingExemptRemaining();
    }

    function _window(uint256 total, uint256 offset, uint256 limit) private pure returns (uint256 start, uint256 end) {
        if (offset >= total) return (total, total);
        start = offset;
        end = limit > total - offset ? total : offset + limit;
    }
}
