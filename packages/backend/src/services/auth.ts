import bcrypt from 'bcrypt';
import { prisma } from '../db/client';
import { CONFIG } from '../config';

const SALT_ROUNDS = 12;

export interface SignupData {
  email: string;
  username: string;
  password: string;
  walletAddress?: string;
}

export interface LoginData {
  email: string;
  password: string;
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Create a new user account
 */
export async function createUser(data: SignupData) {
  // Check if email already exists
  const existingEmail = await prisma.user.findUnique({
    where: { email: data.email.toLowerCase() },
  });

  if (existingEmail) {
    throw new Error('Email already registered');
  }

  // Check if username already exists
  const existingUsername = await prisma.user.findUnique({
    where: { username: data.username.toLowerCase() },
  });

  if (existingUsername) {
    throw new Error('Username already taken');
  }

  // Check if wallet already linked (if provided)
  if (data.walletAddress) {
    const existingWallet = await prisma.user.findUnique({
      where: { walletAddress: data.walletAddress.toLowerCase() },
    });

    if (existingWallet) {
      throw new Error('Wallet address already linked to another account');
    }
  }

  // Hash password
  const passwordHash = await hashPassword(data.password);

  // Create user with initial chip balance
  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: data.email.toLowerCase(),
        username: data.username.toLowerCase(),
        passwordHash,
        walletAddress: data.walletAddress?.toLowerCase(),
      },
    });

    // Create chip balance (starts at 0)
    await tx.chipBalance.create({
      data: {
        userId: newUser.id,
        chips: 0n,
      },
    });

    return newUser;
  });

  // Return user without password hash
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    walletAddress: user.walletAddress,
    createdAt: user.createdAt,
  };
}

/**
 * Authenticate a user and return user data
 */
export async function authenticateUser(data: LoginData) {
  // Find user by email
  const user = await prisma.user.findUnique({
    where: { email: data.email.toLowerCase() },
    include: {
      chipBalance: true,
    },
  });

  if (!user) {
    throw new Error('Invalid email or password');
  }

  // Check if user has a password (wallet-only users don't)
  if (!user.passwordHash) {
    throw new Error('This account was created via wallet. Please connect your wallet to login.');
  }

  // Verify password
  const isValid = await verifyPassword(data.password, user.passwordHash);

  if (!isValid) {
    throw new Error('Invalid email or password');
  }

  // Return user data without password hash
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    avatarId: user.avatarId,
    walletAddress: user.walletAddress,
    pfpUrl: user.pfpUrl,
    chips: user.chipBalance?.chips.toString() || '0',
    createdAt: user.createdAt,
  };
}

/**
 * Get user by ID (for token validation)
 */
export async function getUserById(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      chipBalance: true,
    },
  });

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    avatarId: user.avatarId,
    walletAddress: user.walletAddress,
    pfpUrl: user.pfpUrl,
    chips: user.chipBalance?.chips.toString() || '0',
    createdAt: user.createdAt,
  };
}

/**
 * Link wallet address to existing account
 */
export async function linkWallet(userId: string, walletAddress: string) {
  // Check if wallet already linked
  const existingWallet = await prisma.user.findUnique({
    where: { walletAddress: walletAddress.toLowerCase() },
  });

  if (existingWallet && existingWallet.id !== userId) {
    throw new Error('Wallet address already linked to another account');
  }

  // Update user
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      walletAddress: walletAddress.toLowerCase(),
    },
  });

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    walletAddress: user.walletAddress,
  };
}
