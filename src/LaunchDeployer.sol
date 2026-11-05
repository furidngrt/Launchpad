// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {BondingCurve} from "./BondingCurve.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {IBuybackVault, IFeeEscrow, ILaunchDeployer} from "./interfaces/ILaunchpad.sol";

/// @title LaunchDeployer
/// @notice Deploys the curve and token pair for one launch on the factory's
/// behalf.
///
/// It is a separate contract for one practical reason: embedding two full
/// contracts' creation code inside the factory was the single largest
/// contributor to its deployed size, and the factory has to stay under the
/// EVM's code size limit. Both new contracts are still told the real factory's
/// address rather than this helper's, because that is what they gate their
/// privileged calls on.
///
/// Addresses come from CREATE2 rather than CREATE so that neither depends on
/// this contract's nonce, and therefore on the order launches happen to land
/// in. Under CREATE the tenth launch simply took the tenth address, so an
/// address quoted before a launch confirmed committed to nothing and a
/// different launch could arrive there instead. Under CREATE2 the address is a
/// function of the salt and the creation code, and the creation code carries
/// every constructor argument, so an address can only ever hold the exact
/// launch it was computed from.
contract LaunchDeployer is ILaunchDeployer {
    /// @dev Metadata is written once and read back by functions that return
    /// whole strings. An unbounded write produces a token whose metadata call
    /// can no longer be served, and the strings are immutable afterwards, so
    /// this is the only place the limit can be enforced.
    uint256 private constant MAX_NAME = 64;
    uint256 private constant MAX_SYMBOL = 16;
    uint256 private constant MAX_LOGO = 512;
    uint256 private constant MAX_DESCRIPTION = 2048;
    uint256 private constant MAX_LINK = 256;

    error NotFactory();
    error MetadataTooLong();

    /// @notice The factory this deployer serves.
    address public immutable factory;

    constructor(address factory_) {
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @notice Deploys a launch's curve and token.
    /// @dev Reverts when the pair already exists, which happens when a creator
    /// reuses a salt on otherwise identical terms. A caller can test for that
    /// in advance with `predict`.
    function deploy(Deployment calldata deployment) external onlyFactory returns (address token, address curve) {
        _checkMetadata(deployment);
        bytes32 salt = _salt(deployment);
        curve = Create2.deploy(0, salt, _curveCode(deployment));
        token = Create2.deploy(0, salt, _tokenCode(deployment, curve));
    }

    /// @notice The addresses `deploy` would produce, without deploying.
    /// @dev The token is derived from the curve because the curve's address is
    /// one of the token's constructor arguments, so the pair has to be computed
    /// in deployment order.
    function predict(Deployment calldata deployment) external view returns (address token, address curve) {
        bytes32 salt = _salt(deployment);
        curve = Create2.computeAddress(salt, keccak256(_curveCode(deployment)));
        token = Create2.computeAddress(salt, keccak256(_tokenCode(deployment, curve)));
    }

    /// @dev The creator's chosen salt, namespaced by the account the factory
    /// authenticated. The fee recipient is deliberately not the namespace: any
    /// caller may name an arbitrary payout address and could otherwise squat
    /// another creator's deployment.
    function _salt(Deployment calldata deployment) private pure returns (bytes32) {
        return keccak256(abi.encode(deployment.creator, deployment.salt));
    }

    /// @dev Shared by deploy and predict so the two can never disagree.
    function _curveCode(Deployment calldata deployment) private view returns (bytes memory) {
        return abi.encodePacked(
            type(BondingCurve).creationCode,
            abi.encode(
                deployment.quote,
                deployment.feeRecipient,
                factory,
                deployment.policy,
                IFeeEscrow(deployment.escrow),
                IBuybackVault(deployment.buybackVault),
                deployment.virtualQuote,
                deployment.graduationTarget,
                deployment.tradeFeeBps,
                deployment.creatorFeeBps,
                deployment.buybackEnabled
            )
        );
    }

    function _tokenCode(Deployment calldata deployment, address curve) private view returns (bytes memory) {
        return abi.encodePacked(
            type(LaunchToken).creationCode,
            abi.encode(
                deployment.params.name,
                deployment.params.symbol,
                deployment.params.logo,
                deployment.params.description,
                deployment.params.website,
                deployment.params.social,
                deployment.creator,
                curve,
                factory,
                deployment.supply
            )
        );
    }

    /// @dev The factory already rejects an empty name or symbol, so only the
    /// upper bounds are checked here.
    function _checkMetadata(Deployment calldata deployment) private pure {
        if (
            bytes(deployment.params.name).length > MAX_NAME || bytes(deployment.params.symbol).length > MAX_SYMBOL
                || bytes(deployment.params.logo).length > MAX_LOGO
                || bytes(deployment.params.description).length > MAX_DESCRIPTION
                || bytes(deployment.params.website).length > MAX_LINK
                || bytes(deployment.params.social).length > MAX_LINK
        ) {
            revert MetadataTooLong();
        }
    }
}
