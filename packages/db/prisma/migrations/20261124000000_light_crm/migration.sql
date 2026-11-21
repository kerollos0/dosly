-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'INTERESTED', 'ORDERED', 'WON', 'LOST');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "adTitle" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'direct',
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "stageAt" TIMESTAMP(3),
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Contact_clientId_stage_idx" ON "Contact"("clientId", "stage");

-- CreateIndex
CREATE INDEX "Contact_clientId_adId_idx" ON "Contact"("clientId", "adId");


-- Backfill: people who came from an ad, and where existing customers already are.
UPDATE "Contact" SET "source" = 'ad' WHERE "adId" IS NOT NULL;
UPDATE "Contact" c SET "stage" = 'ORDERED', "stageAt" = o.at FROM (SELECT "contactId", max("placedAt") AS at FROM "StoreOrder" WHERE "contactId" IS NOT NULL AND status NOT IN ('CANCELLED', 'RETURNED', 'FAILED') GROUP BY "contactId") o WHERE o."contactId" = c.id;
UPDATE "Contact" c SET "stage" = 'WON' FROM "StoreOrder" o WHERE o."contactId" = c.id AND o.status = 'DELIVERED';
