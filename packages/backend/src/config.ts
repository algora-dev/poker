import { config } from 'dotenv';

config();

export const CONFIG = {
  // Server
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3000', 10),
  SOCKET_PORT: parseInt(process.env.SOCKET_PORT || process.env.PORT || '3000', 10),
  
  // Database
  DATABASE_URL: process.env.DATABASE_URL || '',
  
  // JWT
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_ACCESS_EXPIRES: process.env.JWT_ACCESS_EXPIRES || '15m',
  JWT_REFRESH_EXPIRES: process.env.JWT_REFRESH_EXPIRES || '7d',
  
  // Blockchain
  RPC_URL: process.env.RPC_URL || 'https://rpc.linea.build',
  CHAIN_ID: parseInt(process.env.CHAIN_ID || '59144', 10),
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS || '',
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
  CONFIRMATIONS: parseInt(process.env.CONFIRMATIONS || '6', 10),
  MUSD_TOKEN_ADDRESS: process.env.MUSD_TOKEN_ADDRESS || '',
  
  // Withdrawal
  WITHDRAWAL_MODE: (process.env.WITHDRAWAL_MODE || 'manual') as 'manual' | 'auto',
  
  // Admin
  ADMIN_SECRET: process.env.ADMIN_SECRET || 'change-me-in-production',
  
  // Optional
  REDIS_URL: process.env.REDIS_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  
  // Uploads
  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '5242880', 10), // 5MB
} as const;

// Validation
const requiredVars = [
  'DATABASE_URL',
  'JWT_SECRET',
  'CONTRACT_ADDRESS',
  'PRIVATE_KEY',
  'MUSD_TOKEN_ADDRESS',
];

for (const varName of requiredVars) {
  if (!CONFIG[varName as keyof typeof CONFIG]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
}

export default CONFIG;
