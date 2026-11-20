-- CreateEnum
CREATE TYPE "StoreKind" AS ENUM ('EASYORDERS', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'FAILED');

-- CreateEnum
CREATE TYPE "ConfirmState" AS ENUM ('NONE', 'SENT', 'CONFIRMED', 'DECLINED', 'NO_ANSWER', 'NOT_SENT');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "adId" TEXT,
ADD COLUMN     "adReferredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "dedupeKey" TEXT;

-- CreateTable
CREATE TABLE "AdAd" (
    "adAccountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,

    CONSTRAINT "AdAd_pkey" PRIMARY KEY ("adAccountId","externalId")
);

-- CreateTable
CREATE TABLE "StoreConnection" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "StoreKind" NOT NULL,
    "name" TEXT NOT NULL,
    "hookId" TEXT NOT NULL,
    "secretEnc" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "status" "ChannelStatus" NOT NULL DEFAULT 'CONNECTED',
    "lastOrderAt" TIMESTAMP(3),
    "lastError" TEXT,
    "autoConfirm" BOOLEAN NOT NULL DEFAULT true,
    "waNumberId" TEXT,
    "confirmTemplate" TEXT,
    "confirmWaitMin" INTEGER NOT NULL DEFAULT 120,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreOrder" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "rawStatus" TEXT,
    "cod" BOOLEAN NOT NULL DEFAULT true,
    "paymentMethod" TEXT,
    "currency" TEXT NOT NULL,
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "shippingMinor" BIGINT NOT NULL DEFAULT 0,
    "customerName" TEXT,
    "phone" TEXT,
    "waId" TEXT,
    "city" TEXT,
    "address" TEXT,
    "items" JSONB NOT NULL,
    "trackingNumber" TEXT,
    "trackingCompany" TEXT,
    "trackingUrl" TEXT,
    "shipmentStatus" TEXT,
    "utmSource" TEXT,
    "utmCampaign" TEXT,
    "fbclid" TEXT,
    "campaignId" TEXT,
    "attribution" TEXT,
    "contactId" TEXT,
    "confirm" "ConfirmState" NOT NULL DEFAULT 'NONE',
    "confirmMessageId" TEXT,
    "confirmSentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "confirmError" TEXT,
    "followUpDoneAt" TIMESTAMP(3),
    "followUpById" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdAd_externalId_idx" ON "AdAd"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreConnection_hookId_key" ON "StoreConnection"("hookId");

-- CreateIndex
CREATE INDEX "StoreConnection_agencyId_idx" ON "StoreConnection"("agencyId");

-- CreateIndex
CREATE INDEX "StoreConnection_clientId_idx" ON "StoreConnection"("clientId");

-- CreateIndex
CREATE INDEX "StoreOrder_clientId_placedAt_idx" ON "StoreOrder"("clientId", "placedAt");

-- CreateIndex
CREATE INDEX "StoreOrder_agencyId_confirm_idx" ON "StoreOrder"("agencyId", "confirm");

-- CreateIndex
CREATE INDEX "StoreOrder_confirm_confirmSentAt_idx" ON "StoreOrder"("confirm", "confirmSentAt");

-- CreateIndex
CREATE INDEX "StoreOrder_contactId_idx" ON "StoreOrder"("contactId");

-- CreateIndex
CREATE INDEX "StoreOrder_confirmMessageId_idx" ON "StoreOrder"("confirmMessageId");

-- CreateIndex
CREATE INDEX "StoreOrder_clientId_waId_idx" ON "StoreOrder"("clientId", "waId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreOrder_storeId_externalId_key" ON "StoreOrder"("storeId", "externalId");

-- CreateIndex
CREATE INDEX "Contact_clientId_waId_idx" ON "Contact"("clientId", "waId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_dedupeKey_key" ON "WebhookEvent"("dedupeKey");

-- AddForeignKey
ALTER TABLE "AdAd" ADD CONSTRAINT "AdAd_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAd" ADD CONSTRAINT "AdAd_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreConnection" ADD CONSTRAINT "StoreConnection_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreConnection" ADD CONSTRAINT "StoreConnection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreConnection" ADD CONSTRAINT "StoreConnection_waNumberId_fkey" FOREIGN KEY ("waNumberId") REFERENCES "WhatsAppNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_followUpById_fkey" FOREIGN KEY ("followUpById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

