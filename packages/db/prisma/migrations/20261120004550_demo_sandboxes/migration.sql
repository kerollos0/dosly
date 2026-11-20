-- AlterTable
ALTER TABLE "Agency" ADD COLUMN     "demoExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Agency_demoExpiresAt_idx" ON "Agency"("demoExpiresAt");
