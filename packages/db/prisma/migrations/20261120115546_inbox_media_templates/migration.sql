-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "durationSec" DOUBLE PRECISION,
ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "mediaHeight" INTEGER,
ADD COLUMN     "mediaKey" TEXT,
ADD COLUMN     "mediaMime" TEXT,
ADD COLUMN     "mediaSha256" TEXT,
ADD COLUMN     "mediaSize" INTEGER,
ADD COLUMN     "mediaStatus" "MediaStatus",
ADD COLUMN     "mediaWidth" INTEGER,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "previewKey" TEXT,
ADD COLUMN     "voice" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WhatsAppNumber" ADD COLUMN     "templatesSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WaTemplate" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "waNumberId" TEXT NOT NULL,
    "metaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "parameterFormat" TEXT NOT NULL DEFAULT 'POSITIONAL',
    "components" JSONB NOT NULL,
    "reason" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaTemplate_metaId_idx" ON "WaTemplate"("metaId");

-- CreateIndex
CREATE UNIQUE INDEX "WaTemplate_waNumberId_name_language_key" ON "WaTemplate"("waNumberId", "name", "language");

-- CreateIndex
CREATE INDEX "Message_mediaStatus_createdAt_idx" ON "Message"("mediaStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "WaTemplate" ADD CONSTRAINT "WaTemplate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaTemplate" ADD CONSTRAINT "WaTemplate_waNumberId_fkey" FOREIGN KEY ("waNumberId") REFERENCES "WhatsAppNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
