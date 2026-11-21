-- CreateTable
CREATE TABLE "AutoCommentClaim" (
    "socialAccountId" TEXT NOT NULL,
    "postExternalId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoCommentClaim_pkey" PRIMARY KEY ("socialAccountId","postExternalId","authorId")
);

-- AddForeignKey
ALTER TABLE "AutoCommentClaim" ADD CONSTRAINT "AutoCommentClaim_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
