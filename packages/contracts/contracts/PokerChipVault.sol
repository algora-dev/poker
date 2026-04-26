// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title PokerChipVault
 * @notice Manages deposits and withdrawals of mUSD for poker game chips
 * @dev Server acts as owner and processes withdrawals after validating in-game balances
 */
contract PokerChipVault is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    // Mapping of user address to total deposited amount
    mapping(address => uint256) public totalDeposits;

    // Mapping of user address to pending withdrawal amount
    mapping(address => uint256) public pendingWithdrawals;

    // Minimum deposit amount (prevents dust attacks)
    uint256 public minDepositAmount = 1e6; // 1 mUSD (6 decimals)

    // Minimum withdrawal amount
    uint256 public minWithdrawalAmount = 1e6; // 1 mUSD (6 decimals)

    // Events
    event Deposit(
        address indexed user,
        uint256 amount,
        uint256 timestamp,
        uint256 blockNumber
    );

    event WithdrawalRequested(
        address indexed user,
        uint256 amount,
        uint256 timestamp
    );

    event WithdrawalCompleted(
        address indexed user,
        uint256 amount,
        uint256 timestamp
    );

    event WithdrawalRejected(
        address indexed user,
        uint256 amount,
        uint256 timestamp,
        string reason
    );

    event MinDepositAmountUpdated(uint256 oldAmount, uint256 newAmount);
    event MinWithdrawalAmountUpdated(uint256 oldAmount, uint256 newAmount);
    
    event FeesWithdrawn(
        address indexed owner,
        uint256 amount,
        uint256 timestamp
    );

    /**
     * @notice Constructor
     * @param _token Address of the mUSD token on Linea
     */
    constructor(address _token) Ownable(msg.sender) {
        require(_token != address(0), "Invalid token address");
        token = IERC20(_token);
    }

    /**
     * @notice Deposit mUSD to receive poker chips
     * @param amount Amount of mUSD to deposit (in token units)
     */
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount >= minDepositAmount, "Amount below minimum");
        
        // Transfer tokens from user to contract
        token.safeTransferFrom(msg.sender, address(this), amount);
        
        // Update user's total deposits
        totalDeposits[msg.sender] += amount;
        
        emit Deposit(msg.sender, amount, block.timestamp, block.number);
    }

    /**
     * @notice Request withdrawal of chips back to mUSD
     * @param amount Amount of mUSD to withdraw
     * @dev User requests withdrawal; server validates and calls completeWithdrawal
     */
    function requestWithdrawal(uint256 amount) external nonReentrant whenNotPaused {
        require(amount >= minWithdrawalAmount, "Amount below minimum");
        require(pendingWithdrawals[msg.sender] == 0, "Pending withdrawal exists");
        
        pendingWithdrawals[msg.sender] = amount;
        
        emit WithdrawalRequested(msg.sender, amount, block.timestamp);
    }

    /**
     * @notice Complete a withdrawal (called by server after validation)
     * @param user Address of the user
     * @param amount Amount to withdraw
     * @dev Only owner (server) can call this after validating chip balance
     */
    function completeWithdrawal(address user, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        require(pendingWithdrawals[user] == amount, "Amount mismatch");
        require(token.balanceOf(address(this)) >= amount, "Insufficient contract balance");
        
        // Clear pending withdrawal
        pendingWithdrawals[user] = 0;
        
        // Transfer tokens to user
        token.safeTransfer(user, amount);
        
        emit WithdrawalCompleted(user, amount, block.timestamp);
    }

    /**
     * @notice Reject a withdrawal request (called by server if validation fails)
     * @param user Address of the user
     * @param reason Rejection reason
     */
    function rejectWithdrawal(address user, string calldata reason)
        external
        onlyOwner
    {
        uint256 amount = pendingWithdrawals[user];
        require(amount > 0, "No pending withdrawal");
        
        // Clear pending withdrawal
        pendingWithdrawals[user] = 0;
        
        emit WithdrawalRejected(user, amount, block.timestamp, reason);
    }

    /**
     * @notice Update minimum deposit amount
     * @param newAmount New minimum amount
     */
    function setMinDepositAmount(uint256 newAmount) external onlyOwner {
        uint256 oldAmount = minDepositAmount;
        minDepositAmount = newAmount;
        emit MinDepositAmountUpdated(oldAmount, newAmount);
    }

    /**
     * @notice Update minimum withdrawal amount
     * @param newAmount New minimum amount
     */
    function setMinWithdrawalAmount(uint256 newAmount) external onlyOwner {
        uint256 oldAmount = minWithdrawalAmount;
        minWithdrawalAmount = newAmount;
        emit MinWithdrawalAmountUpdated(oldAmount, newAmount);
    }

    /**
     * @notice Get total token balance held by contract
     * @return Total mUSD balance
     */
    function getTotalBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /**
     * @notice Withdraw house fees (excess mUSD beyond player chip liability)
     * @param amount Amount of mUSD to withdraw
     * @dev OWNER MUST MANUALLY VERIFY: Check backend database for total player chip balances
     * @dev Ensure: contractBalance - amount >= sum(all_player_chip_balances)
     * @dev This is a MANUAL process for MVP - automated liability reporting comes later
     */
    function withdrawFees(uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        require(amount > 0, "Amount must be > 0");
        
        uint256 contractBalance = token.balanceOf(address(this));
        
        require(
            contractBalance >= amount,
            "Insufficient balance"
        );
        
        // Transfer fees to owner
        // Owner is responsible for ensuring this doesn't drain player liability
        token.safeTransfer(owner(), amount);
        
        emit FeesWithdrawn(owner(), amount, block.timestamp);
    }

    /**
     * @notice Get current total player liability (for future oracle implementation)
     * @return Current reported liability (0 for MVP, to be implemented later)
     * @dev TODO: Implement oracle pattern where backend reports total chip balances
     */
    function getPlayerLiability() public pure returns (uint256) {
        // Placeholder for future Option C implementation
        // Backend will call updatePlayerLiability(totalChips) periodically
        return 0;
    }

    /**
     * @notice Emergency pause (stops deposits/withdrawals)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Emergency token recovery (only for tokens accidentally sent)
     * @param tokenAddress Address of token to recover
     * @param amount Amount to recover
     * @dev Cannot recover the main mUSD token
     */
    function recoverToken(address tokenAddress, uint256 amount)
        external
        onlyOwner
    {
        require(tokenAddress != address(token), "Cannot recover main token");
        IERC20(tokenAddress).safeTransfer(owner(), amount);
    }
}
