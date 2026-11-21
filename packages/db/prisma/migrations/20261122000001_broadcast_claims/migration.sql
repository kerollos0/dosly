-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN "audienceAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BroadcastRecipient" ADD COLUMN "lockedUntil" TIMESTAMP(3);
