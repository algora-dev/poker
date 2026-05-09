// Minimal env stubs so src/config.ts validation passes during unit tests.
// Unit tests must NEVER hit a real database or real chain — Prisma calls and
// blockchain calls are mocked per test.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-jwt-secret-not-used-in-production';
process.env.CONTRACT_ADDRESS ??= '0x0000000000000000000000000000000000000000';
process.env.PRIVATE_KEY ??=
  '0x0000000000000000000000000000000000000000000000000000000000000001';
process.env.MUSD_TOKEN_ADDRESS ??=
  '0x0000000000000000000000000000000000000000';
