// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title LaunchToken
/// @notice The fixed-supply ERC-20 deployed for one launch.
///
/// The entire supply is minted to the launch's bonding curve in this
/// constructor. Nobody, the creator included, holds an allocation set aside
/// before trading opens: the only way to obtain the token is to buy it from
/// the curve, and later from the graduated pool, on the same terms as everyone
/// else.
///
/// What this contract deliberately does not have is as much of its design as
/// what it does. There is no owner, no mint function after construction, no
/// pause, no blocklist, no transfer fee and no proxy. Those absences are not
/// promises to behave: the functions do not exist, so no key and no governance
/// vote can introduce them later.
///
/// `ERC20Permit` is included so holders can approve by signature, which lets
/// an interface bundle an approval and a trade into one transaction instead of
/// asking for two. `ERC20Burnable` lets a holder destroy their own balance and
/// nobody else's, so `totalSupply` can fall below the launch supply but never
/// rise above it.
contract LaunchToken is ERC20, ERC20Burnable, ERC20Permit {
    error ZeroAddress();

    /// @notice Account that created the launch. Reference data for attribution;
    /// it carries no privileges whatsoever over this token.
    address public immutable creator;

    /// @notice Protocol factory that authorised the launch.
    address public immutable factory;

    /// @notice Bonding curve the whole supply was minted to.
    address public immutable curve;

    /// @notice Creator-supplied image reference shown by interfaces.
    string public logo;

    /// @notice Creator-supplied description shown by interfaces.
    string public description;

    /// @notice Creator-supplied project link.
    string public website;

    /// @notice Creator-supplied social link.
    string public social;

    /// @param curve_ Receives the entire supply; also the only holder at creation.
    /// @param factory_ Passed explicitly rather than read from `msg.sender`,
    /// because the factory deploys this token through a helper contract to stay
    /// within the deployed-code size limit, so `msg.sender` here is that helper.
    constructor(
        string memory name_,
        string memory symbol_,
        string memory logo_,
        string memory description_,
        string memory website_,
        string memory social_,
        address creator_,
        address curve_,
        address factory_,
        uint256 supply_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (creator_ == address(0) || curve_ == address(0) || factory_ == address(0)) revert ZeroAddress();

        creator = creator_;
        factory = factory_;
        curve = curve_;
        logo = logo_;
        description = description_;
        website = website_;
        social = social_;

        _mint(curve_, supply_);
    }

    /// @notice Everything the creator supplied at launch, in one call, so an
    /// interface does not pay for six separate reads.
    function metadata()
        external
        view
        returns (
            address tokenCreator,
            string memory tokenLogo,
            string memory tokenDescription,
            string memory tokenWebsite,
            string memory tokenSocial
        )
    {
        return (creator, logo, description, website, social);
    }
}
