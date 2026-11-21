-- CreateEnum
CREATE TYPE "AiMode" AS ENUM ('OFF', 'SUGGEST', 'AUTO');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "aiHandoffAt" TIMESTAMP(3),
ADD COLUMN     "aiHandoffReason" TEXT,
ADD COLUMN     "aiReplyAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AiAssistant" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "mode" "AiMode" NOT NULL DEFAULT 'SUGGEST',
    "channels" "Channel"[],
    "knowledge" TEXT NOT NULL DEFAULT '',
    "suggested" INTEGER NOT NULL DEFAULT 0,
    "autoSent" INTEGER NOT NULL DEFAULT 0,
    "handoffs" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" BIGINT NOT NULL DEFAULT 0,
    "tokensOut" BIGINT NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAssistant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiAssistant_clientId_key" ON "AiAssistant"("clientId");

-- CreateIndex
CREATE INDEX "AiAssistant_agencyId_idx" ON "AiAssistant"("agencyId");

-- AddForeignKey
ALTER TABLE "AiAssistant" ADD CONSTRAINT "AiAssistant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

