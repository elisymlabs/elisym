// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ElisymConfig - the protocol fee and treasury of elisym on one EVM chain.
/// @notice The EVM twin of the `elisym-config` Solana program: clients READ the fee rate
/// and the treasury from here and ship no fallback, so the on-chain value is the only
/// source of truth. It holds no funds and moves none. No proxy: a new version is a new
/// address in the SDK registry.
contract ElisymConfig {
    /// @notice The hard cap on the fee, in basis points (10%). The same cap as on Solana.
    uint16 public constant MAX_FEE_BPS = 1000;

    address public owner;
    address public pendingOwner;
    address public treasury;
    uint16 public feeBps;

    event OwnerProposed(address indexed owner, address indexed proposed);
    event OwnerAccepted(address indexed previousOwner, address indexed owner);
    event PendingOwnerCancelled(address indexed cancelled);
    event FeeBpsSet(uint16 previousFeeBps, uint16 feeBps);
    event TreasurySet(address indexed previousTreasury, address indexed treasury);

    error NotOwner();
    error NotPendingOwner();
    error FeeTooHigh();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address treasury_, uint16 feeBps_) {
        if (owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        owner = owner_;
        treasury = treasury_;
        feeBps = feeBps_;
        emit OwnerAccepted(address(0), owner_);
        emit TreasurySet(address(0), treasury_);
        emit FeeBpsSet(0, feeBps_);
    }

    /// @notice Both values in one call, so a reader never sees a fee from one block and a
    /// treasury from another.
    function config() external view returns (uint16, address) {
        return (feeBps, treasury);
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeBpsSet(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Step one of the two-step handover: the owner names a successor.
    function proposeOwner(address proposed) external onlyOwner {
        if (proposed == address(0)) revert ZeroAddress();
        pendingOwner = proposed;
        emit OwnerProposed(owner, proposed);
    }

    /// @notice Step two: the successor accepts, which proves it can sign.
    function acceptOwner() external {
        // With nothing pending, `pendingOwner` is the zero address - which must not read as
        // "the zero address may accept".
        if (pendingOwner == address(0) || msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnerAccepted(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function cancelPendingOwner() external onlyOwner {
        emit PendingOwnerCancelled(pendingOwner);
        pendingOwner = address(0);
    }
}
