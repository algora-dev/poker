import { expect } from 'chai';
import { ethers } from 'hardhat';
import { PokerChipVault } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('PokerChipVault', function () {
  let vault: PokerChipVault;
  let mockToken: any;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const INITIAL_SUPPLY = ethers.parseUnits('1000000', 6); // 1M mUSD
  const MIN_DEPOSIT = ethers.parseUnits('1', 6); // 1 mUSD

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy mock ERC20 token
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    mockToken = await MockERC20.deploy('Mock USD', 'mUSD', 6);
    await mockToken.waitForDeployment();

    // Mint tokens to test users
    await mockToken.mint(user1.address, INITIAL_SUPPLY);
    await mockToken.mint(user2.address, INITIAL_SUPPLY);

    // Deploy PokerChipVault
    const PokerChipVault = await ethers.getContractFactory('PokerChipVault');
    vault = await PokerChipVault.deploy(await mockToken.getAddress());
    await vault.waitForDeployment();
  });

  describe('Deployment', function () {
    it('Should set the correct token address', async function () {
      expect(await vault.token()).to.equal(await mockToken.getAddress());
    });

    it('Should set the correct owner', async function () {
      expect(await vault.owner()).to.equal(owner.address);
    });

    it('Should set default minimum amounts', async function () {
      expect(await vault.minDepositAmount()).to.equal(MIN_DEPOSIT);
      expect(await vault.minWithdrawalAmount()).to.equal(MIN_DEPOSIT);
    });
  });

  describe('Deposits', function () {
    it('Should allow users to deposit tokens', async function () {
      const depositAmount = ethers.parseUnits('100', 6);

      // Approve vault to spend tokens
      await mockToken.connect(user1).approve(await vault.getAddress(), depositAmount);

      // Deposit
      await expect(vault.connect(user1).deposit(depositAmount))
        .to.emit(vault, 'Deposit')
        .withArgs(user1.address, depositAmount, await ethers.provider.getBlock('latest').then(b => b!.timestamp + 1), await ethers.provider.getBlockNumber() + 1);

      // Check balances
      expect(await vault.totalDeposits(user1.address)).to.equal(depositAmount);
      expect(await mockToken.balanceOf(await vault.getAddress())).to.equal(depositAmount);
    });

    it('Should reject deposits below minimum', async function () {
      const tooSmall = ethers.parseUnits('0.5', 6);
      await mockToken.connect(user1).approve(await vault.getAddress(), tooSmall);

      await expect(vault.connect(user1).deposit(tooSmall)).to.be.revertedWith(
        'Amount below minimum'
      );
    });

    it('Should accumulate multiple deposits', async function () {
      const amount1 = ethers.parseUnits('100', 6);
      const amount2 = ethers.parseUnits('50', 6);

      await mockToken.connect(user1).approve(await vault.getAddress(), amount1 + amount2);
      await vault.connect(user1).deposit(amount1);
      await vault.connect(user1).deposit(amount2);

      expect(await vault.totalDeposits(user1.address)).to.equal(amount1 + amount2);
    });
  });

  describe('Withdrawals', function () {
    beforeEach(async function () {
      // Setup: user1 deposits 1000 mUSD
      const depositAmount = ethers.parseUnits('1000', 6);
      await mockToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount);
    });

    it('Should allow users to request withdrawal', async function () {
      const withdrawAmount = ethers.parseUnits('500', 6);

      await expect(vault.connect(user1).requestWithdrawal(withdrawAmount))
        .to.emit(vault, 'WithdrawalRequested')
        .withArgs(user1.address, withdrawAmount, await ethers.provider.getBlock('latest').then(b => b!.timestamp + 1));

      expect(await vault.pendingWithdrawals(user1.address)).to.equal(withdrawAmount);
    });

    it('Should not allow multiple pending withdrawals', async function () {
      const amount = ethers.parseUnits('100', 6);
      await vault.connect(user1).requestWithdrawal(amount);

      await expect(vault.connect(user1).requestWithdrawal(amount)).to.be.revertedWith(
        'Pending withdrawal exists'
      );
    });

    it('Should allow owner to complete withdrawal', async function () {
      const withdrawAmount = ethers.parseUnits('500', 6);
      await vault.connect(user1).requestWithdrawal(withdrawAmount);

      const balanceBefore = await mockToken.balanceOf(user1.address);

      await expect(vault.connect(owner).completeWithdrawal(user1.address, withdrawAmount))
        .to.emit(vault, 'WithdrawalCompleted')
        .withArgs(user1.address, withdrawAmount, await ethers.provider.getBlock('latest').then(b => b!.timestamp + 1));

      expect(await vault.pendingWithdrawals(user1.address)).to.equal(0);
      expect(await mockToken.balanceOf(user1.address)).to.equal(balanceBefore + withdrawAmount);
    });

    it('Should allow owner to reject withdrawal', async function () {
      const withdrawAmount = ethers.parseUnits('500', 6);
      await vault.connect(user1).requestWithdrawal(withdrawAmount);

      await expect(
        vault.connect(owner).rejectWithdrawal(user1.address, 'Insufficient chips')
      )
        .to.emit(vault, 'WithdrawalRejected')
        .withArgs(user1.address, withdrawAmount, await ethers.provider.getBlock('latest').then(b => b!.timestamp + 1), 'Insufficient chips');

      expect(await vault.pendingWithdrawals(user1.address)).to.equal(0);
    });

    it('Should reject withdrawal completion by non-owner', async function () {
      const withdrawAmount = ethers.parseUnits('500', 6);
      await vault.connect(user1).requestWithdrawal(withdrawAmount);

      await expect(
        vault.connect(user2).completeWithdrawal(user1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, 'OwnableUnauthorizedAccount');
    });
  });

  describe('Admin Functions', function () {
    it('Should allow owner to update minimum deposit', async function () {
      const newMin = ethers.parseUnits('10', 6);
      await expect(vault.connect(owner).setMinDepositAmount(newMin))
        .to.emit(vault, 'MinDepositAmountUpdated')
        .withArgs(MIN_DEPOSIT, newMin);

      expect(await vault.minDepositAmount()).to.equal(newMin);
    });

    it('Should allow owner to pause/unpause', async function () {
      await vault.connect(owner).pause();
      expect(await vault.paused()).to.be.true;

      const amount = ethers.parseUnits('100', 6);
      await mockToken.connect(user1).approve(await vault.getAddress(), amount);
      await expect(vault.connect(user1).deposit(amount)).to.be.revertedWithCustomError(vault, 'EnforcedPause');

      await vault.connect(owner).unpause();
      expect(await vault.paused()).to.be.false;
    });
  });

  describe('Profit Withdrawal (Manual Verification MVP)', function () {
    beforeEach(async function () {
      // User1 deposits 1000 mUSD
      const depositAmount = ethers.parseUnits('1000', 6);
      await mockToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount);

      // User2 deposits 500 mUSD
      const deposit2 = ethers.parseUnits('500', 6);
      await mockToken.connect(user2).approve(await vault.getAddress(), deposit2);
      await vault.connect(user2).deposit(deposit2);

      // Total deposited: 1500 mUSD
      // In reality: backend tracks chip balances (may be less due to fees)
    });

    it('Should allow owner to withdraw profit (manual verification)', async function () {
      // Simulate: Players deposited 1500 mUSD, but now only have 1300 chips due to fees
      // House revenue: 200 mUSD
      // Owner manually verifies this in backend database before calling withdrawProfit

      // Add house revenue to contract
      const houseRevenue = ethers.parseUnits('200', 6);
      await mockToken.connect(user1).transfer(await vault.getAddress(), houseRevenue);

      // Contract now has 1700 mUSD (1500 deposits + 200 revenue)
      // Owner verified in backend: players have 1300 chips = 1300 mUSD liability
      // Safe to withdraw: 1700 - 1300 = 400 mUSD profit

      const ownerBalanceBefore = await mockToken.balanceOf(owner.address);
      const withdrawAmount = ethers.parseUnits('200', 6);

      const tx = await vault.connect(owner).withdrawFees(withdrawAmount);
      
      await expect(tx)
        .to.emit(vault, 'FeesWithdrawn');

      const ownerBalanceAfter = await mockToken.balanceOf(owner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(withdrawAmount);
    });

    it('Should prevent withdrawing more than contract balance', async function () {
      // Contract has 1500 mUSD
      // Try to withdraw 2000 mUSD
      const tooMuch = ethers.parseUnits('2000', 6);
      await expect(vault.connect(owner).withdrawFees(tooMuch))
        .to.be.revertedWith('Insufficient balance');
    });

    it('Should allow multiple fee withdrawals', async function () {
      // Add house fees
      const houseFees = ethers.parseUnits('300', 6);
      await mockToken.connect(user1).transfer(await vault.getAddress(), houseFees);

      // First withdrawal
      await vault.connect(owner).withdrawFees(ethers.parseUnits('100', 6));

      // Second withdrawal
      await vault.connect(owner).withdrawFees(ethers.parseUnits('150', 6));

      // Total withdrawn: 250 mUSD
      // Remaining in contract: 1500 + 300 - 250 = 1550 mUSD
      expect(await vault.getTotalBalance()).to.equal(ethers.parseUnits('1550', 6));
    });

    it('Should reject fee withdrawal by non-owner', async function () {
      const amount = ethers.parseUnits('100', 6);
      await expect(vault.connect(user1).withdrawFees(amount))
        .to.be.revertedWithCustomError(vault, 'OwnableUnauthorizedAccount');
    });

    it('Should reject zero amount withdrawal', async function () {
      await expect(vault.connect(owner).withdrawFees(0))
        .to.be.revertedWith('Amount must be > 0');
    });
  });
});
