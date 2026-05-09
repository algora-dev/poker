-- AlterTable
-- Add optimistic-concurrency version counter to Hand. Bumped atomically on
-- every successful action so duplicate/parallel requests cannot double-apply.
-- See audits/t3-poker/06-dave-fix-prompt.md Phase 3 and finding [H-02].
ALTER TABLE "Hand" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
