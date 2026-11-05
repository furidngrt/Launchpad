// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IFeeEscrow} from "./interfaces/ILaunchpad.sol";

/// @title FeeEscrow
/// @notice Holds every recipient's claimable revenue in one place and pays it
/// out only when they ask for it.
///
/// Fees are credited here rather than pushed to wallets as they are earned.
/// That is a deliberate liveness decision: a push model lets one recipient
/// whose address cannot accept a transfer revert the distribution that pays
/// everyone else. Here a failing recipient fails alone.
///
/// Revenue arrives in whatever asset the launch trades against, so the ledger
/// is kept per asset: native ETH in one, each ERC-20 under its own key. A
/// creator with launches against different quote assets holds several separate
/// balances and claims each one independently, because there is no honest
/// exchange rate between them to aggregate over.
contract FeeEscrow is ReentrancyGuard, IFeeEscrow {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error NoBalance();
    error TransferFailed();
    error InsufficientBalance(uint256 requested, uint256 available);

    event Credited(address indexed recipient, address indexed payer, uint256 amount);
    event CreditedToken(address indexed recipient, address indexed token, address indexed payer, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);
    event ClaimedToken(address indexed recipient, address indexed token, uint256 amount);

    mapping(address recipient => uint256 amount) private _balances;
    mapping(address recipient => mapping(address token => uint256 amount)) private _tokenBalances;

    /// @notice Credits the attached ETH to `recipient`.
    /// @dev Open to any caller on purpose: a caller can only ever credit value
    /// they have already attached to the call, so there is no privilege here to
    /// restrict and nothing an attacker gains by calling it.
    function credit(address recipient) external payable {
        if (recipient == address(0)) revert ZeroAddress();
        if (msg.value == 0) return;
        _balances[recipient] += msg.value;
        emit Credited(recipient, msg.sender, msg.value);
    }

    /// @notice Pulls `amount` of `token` from the caller and credits it to `recipient`.
    /// @dev Credits the balance this contract actually received rather than the
    /// amount requested. A quote asset that takes a cut on transfer, or rebases,
    /// would otherwise have this ledger record more liability than it holds, and
    /// the shortfall would land on whichever recipient claimed that asset last.
    function creditToken(address recipient, address token, uint256 amount) external nonReentrant {
        if (recipient == address(0) || token == address(0)) revert ZeroAddress();
        if (amount == 0) return;

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) return;

        _tokenBalances[recipient][token] += received;
        emit CreditedToken(recipient, token, msg.sender, received);
    }

    /// @notice Pays out the caller's whole ETH balance.
    function claim() external nonReentrant returns (uint256 amount) {
        return _claim(msg.sender, _balances[msg.sender]);
    }

    /// @notice Pays out part of the caller's ETH balance.
    function claim(uint256 amount) external nonReentrant returns (uint256) {
        return _claim(msg.sender, amount);
    }

    /// @notice Pays part of the caller's ETH balance to another address.
    /// @dev For a recipient that is credited but cannot itself receive native
    /// value, such as a contract without a payable fallback. Without this its
    /// balance could be credited forever and never withdrawn.
    function claimTo(address to, uint256 amount) external nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        return _claim(to, amount);
    }

    /// @notice Pays out the caller's whole balance of `token`.
    function claimToken(address token) external nonReentrant returns (uint256 amount) {
        return _claimToken(token, msg.sender, _tokenBalances[msg.sender][token]);
    }

    /// @notice Pays part of the caller's balance of `token` to another address.
    function claimTokenTo(address token, address to, uint256 amount) external nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        return _claimToken(token, to, amount);
    }

    /// @notice Pays out part of the caller's balance of `token`.
    /// @dev Partial claims exist because a balance here aggregates credits from
    /// every launch a recipient earns from, and crediting is open to any caller.
    /// Against a quote asset that caps the size of a single transfer, a
    /// whole-balance claim could grow past that cap and revert permanently.
    /// Choosing the amount keeps the aggregate from becoming a single point of
    /// failure.
    function claimToken(address token, uint256 amount) external nonReentrant returns (uint256) {
        return _claimToken(token, msg.sender, amount);
    }

    /// @notice Claimable ETH for `recipient`.
    function balanceOf(address recipient) external view returns (uint256) {
        return _balances[recipient];
    }

    /// @notice Claimable `token` for `recipient`.
    function balanceOfToken(address recipient, address token) external view returns (uint256) {
        return _tokenBalances[recipient][token];
    }

    /// @dev Debits the caller and pays `to`. The ledger is always keyed on the
    /// caller, so nobody can direct another recipient's balance anywhere.
    function _claim(address to, uint256 amount) private returns (uint256) {
        if (amount == 0) revert NoBalance();
        uint256 balance = _balances[msg.sender];
        if (amount > balance) revert InsufficientBalance(amount, balance);

        _balances[msg.sender] = balance - amount;
        (bool sent,) = payable(to).call{value: amount}("");
        if (!sent) revert TransferFailed();

        emit Claimed(msg.sender, amount);
        return amount;
    }

    function _claimToken(address token, address to, uint256 amount) private returns (uint256) {
        if (amount == 0) revert NoBalance();
        uint256 balance = _tokenBalances[msg.sender][token];
        if (amount > balance) revert InsufficientBalance(amount, balance);

        _tokenBalances[msg.sender][token] = balance - amount;
        IERC20(token).safeTransfer(to, amount);

        emit ClaimedToken(msg.sender, token, amount);
        return amount;
    }
}
