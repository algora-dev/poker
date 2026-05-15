// dotenv ships its own types; this resolves cleanly once `npm install`
// has been run. Skip it locally if you haven't installed deps yet.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require('dotenv');

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
  
  // Admin secret: REQUIRED in production (validated below). Empty default so
  // a forgotten env var is loud-fail at startup, not a trivially bypassable auth.
  ADMIN_SECRET: process.env.ADMIN_SECRET || '',
  
  // CORS allowlist: comma-separated list of allowed origins.
  // Empty/unset in development => reflect any origin (back-compat for local dev).
  // In production => MUST be set explicitly; otherwise no cross-origin requests allowed.
  CORS_ORIGINS: process.env.CORS_ORIGINS || '',

  // Test-only: bypass the global 300/min/IP rate-limit so the bot harness
  // can drive the backend at high tempo. Per-route limits (signup, login,
  // action) still apply. Refused in production.
  HARNESS_BYPASS_GLOBAL_RATELIMIT: process.env.HARNESS_BYPASS_GLOBAL_RATELIMIT === '1',

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

// Production safety: never allow the harness rate-limit bypass in prod,
// even if the env var leaks in. This is a test-only escape hatch.
if (CONFIG.NODE_ENV === 'production' && CONFIG.HARNESS_BYPASS_GLOBAL_RATELIMIT) {
  throw new Error('HARNESS_BYPASS_GLOBAL_RATELIMIT must not be set in production');
}

// Admin secret hardening: required and strong in production.
if (CONFIG.NODE_ENV === 'production') {
  if (!CONFIG.ADMIN_SECRET) {
    throw new Error('ADMIN_SECRET is required in production');
  }
  if (CONFIG.ADMIN_SECRET.length < 32) {
    throw new Error('ADMIN_SECRET must be at least 32 characters in production');
  }
  if (CONFIG.ADMIN_SECRET === 'change-me-in-production') {
    throw new Error('ADMIN_SECRET still set to the default placeholder; change it');
  }
}

// SECURITY [audit-30 M-04]: JWT secret hardening in production.
// A weak JWT secret collapses the entire auth model. We already require
// JWT_SECRET (via `requiredVars` above), but the boot-time check below
// catches secrets that exist but are too short or are obvious placeholders.
//
// Mirror the ADMIN_SECRET rules: ≥ 32 chars, no known placeholders.
if (CONFIG.NODE_ENV === 'production') {
  if (CONFIG.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }
  const jwtPlaceholders = [
    'change-me-in-production',
    'secret',
    'jwt-secret',
    'your-secret-here',
    'changeme',
    'changethis',
    'test-secret',
    'dev-secret',
  ];
  if (jwtPlaceholders.includes(CONFIG.JWT_SECRET.toLowerCase())) {
    throw new Error('JWT_SECRET is set to a known placeholder; rotate to a random 256-bit value');
  }
}

export default CONFIG;
