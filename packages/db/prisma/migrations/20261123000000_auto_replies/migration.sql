-- CreateEnum
CREATE TYPE "AutoRuleKind" AS ENUM ('WELCOME', 'AWAY', 'KEYWORD', 'COMMENT');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "autoReplyAt" TIMESTAMP(3),
ADD COLUMN     "awayAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SocialComment" ADD COLUMN     "autoRuleId" TEXT;

-- CreateTable
CREATE TABLE "AutoRule" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "AutoRuleKind" NOT NULL,
    "name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channels" "Channel"[],
    "platforms" "Platform"[],
    "keywords" TEXT[],
    "postExternalId" TEXT,
    "postLabel" TEXT,
    "reply" TEXT,
    "publicReplies" TEXT[],
    "hours" JSONB,
    "fired" INTEGER NOT NULL DEFAULT 0,
    "lastFiredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoRule_clientId_kind_idx" ON "AutoRule"("clientId", "kind");

-- CreateIndex
CREATE INDEX "AutoRule_agencyId_idx" ON "AutoRule"("agencyId");

-- AddForeignKey
ALTER TABLE "AutoRule" ADD CONSTRAINT "AutoRule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

