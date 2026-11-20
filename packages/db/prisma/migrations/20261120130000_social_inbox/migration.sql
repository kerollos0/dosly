-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WHATSAPP', 'MESSENGER', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('OPEN', 'DONE');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "socialAccountId" TEXT,
ADD COLUMN     "username" TEXT,
ALTER COLUMN "waNumberId" DROP NOT NULL,
ALTER COLUMN "waId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "channel" "Channel" NOT NULL DEFAULT 'WHATSAPP',
ADD COLUMN     "socialAccountId" TEXT,
ALTER COLUMN "waNumberId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SocialComment" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "postExternalId" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "authorId" TEXT,
    "authorName" TEXT,
    "body" TEXT NOT NULL,
    "fromPage" BOOLEAN NOT NULL DEFAULT false,
    "sentById" TEXT,
    "status" "CommentStatus" NOT NULL DEFAULT 'OPEN',
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "privateReplyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialComment_agencyId_status_createdAt_idx" ON "SocialComment"("agencyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SocialComment_socialAccountId_postExternalId_createdAt_idx" ON "SocialComment"("socialAccountId", "postExternalId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialComment_socialAccountId_externalId_key" ON "SocialComment"("socialAccountId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_socialAccountId_externalId_key" ON "Contact"("socialAccountId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_socialAccountId_contactId_key" ON "Conversation"("socialAccountId", "contactId");

-- CreateIndex
CREATE INDEX "SocialAccount_platform_externalId_idx" ON "SocialAccount"("platform", "externalId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialComment" ADD CONSTRAINT "SocialComment_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialComment" ADD CONSTRAINT "SocialComment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialComment" ADD CONSTRAINT "SocialComment_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialComment" ADD CONSTRAINT "SocialComment_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

