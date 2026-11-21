-- CreateIndex
CREATE INDEX "Contact_clientId_createdAt_idx" ON "Contact"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_contactId_idx" ON "Conversation"("contactId");

-- People who first reached the client through a private reply to their comment (and no ad).
UPDATE "Contact" c SET source = 'comment', "sourceRef" = s."postExternalId"
FROM "SocialComment" s JOIN "Conversation" v ON v.id = s."privateConversationId"
WHERE v."contactId" = c.id AND c."adId" IS NULL AND c.source = 'direct';
