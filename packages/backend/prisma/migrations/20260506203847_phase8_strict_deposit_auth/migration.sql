-- Phase 8 [H-04]: strict deposit authorization. Bind (userId, wallet, nonce,
-- chainId, contractAddress, optional amount, expiresAt) into the signed
-- challenge and enforce single-use of nonce.
--
-- Existing pre-migration rows have no nonce/chainId/contractAddress and would
-- fail the new validation anyway (and the old 10-min window means any
-- in-flight rows are about to expire). We drop them so we can add the new
-- NOT NULL columns cleanly. No production user data is at risk because the
-- DepositAuthorization table holds short-lived auth challenges, not balances.
DELETE FROM "deposit_authorizations";

-- Drop the pre-Phase-8 unique index on walletAddress: under the new design
-- a wallet may have multiple pending challenges with distinct nonces.
DROP INDEX IF EXISTS "deposit_authorizations_walletAddress_key";

-- Add the structured binding fields.
ALTER TABLE "deposit_authorizations"
  ADD COLUMN "nonce" TEXT NOT NULL,
  ADD COLUMN "chainId" INTEGER NOT NULL,
  ADD COLUMN "contractAddress" TEXT NOT NULL,
  ADD COLUMN "amount" BIGINT,
  ADD COLUMN "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Single-use enforcement: nonce must be globally unique. This is the
-- authoritative replay-protection invariant.
CREATE UNIQUE INDEX "deposit_authorizations_nonce_key"
  ON "deposit_authorizations"("nonce");

-- Useful for the listener's "find a usable auth" query path.
CREATE INDEX "deposit_authorizations_used_expiresAt_idx"
  ON "deposit_authorizations"("used", "expiresAt");
