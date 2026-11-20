-- AlterTable
ALTER TABLE "SocialComment" ADD COLUMN "privateConversationId" TEXT;

-- Every contact and conversation belongs to exactly one channel: a WhatsApp number or a Page/Instagram account.
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_one_channel" CHECK (
  num_nonnulls("waNumberId", "socialAccountId") = 1
  AND ("waNumberId" IS NULL) = ("waId" IS NULL)
  AND ("socialAccountId" IS NULL) = ("externalId" IS NULL)
);
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_one_channel" CHECK (
  num_nonnulls("waNumberId", "socialAccountId") = 1
  AND ("channel" = 'WHATSAPP') = ("waNumberId" IS NOT NULL)
);
