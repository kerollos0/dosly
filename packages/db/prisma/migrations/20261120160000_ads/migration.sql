-- CreateEnum
CREATE TYPE "AdAlertKind" AS ENUM ('ACCOUNT_PROBLEM', 'SPEND_CAP_NEAR', 'CAMPAIGN_ISSUES', 'CAMPAIGN_STOPPED', 'BUDGET_LOW');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "showAdsInPortal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AdAccount" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "timezoneName" TEXT NOT NULL,
    "accountStatus" INTEGER NOT NULL DEFAULT 1,
    "disableReason" INTEGER NOT NULL DEFAULT 0,
    "spendCapMinor" BIGINT,
    "amountSpentMinor" BIGINT NOT NULL DEFAULT 0,
    "accessTokenEnc" TEXT NOT NULL,
    "status" "ChannelStatus" NOT NULL DEFAULT 'CONNECTED',
    "lastError" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "insightsFrom" TEXT,
    "throttledUntil" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "status" TEXT NOT NULL,
    "effectiveStatus" TEXT NOT NULL,
    "dailyBudgetMinor" BIGINT,
    "lifetimeBudgetMinor" BIGINT,
    "budgetRemainingMinor" BIGINT,
    "checkedStatus" TEXT,
    "issues" JSONB,
    "startTime" TIMESTAMP(3),
    "stopTime" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdInsightDaily" (
    "campaignId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "spendMinor" BIGINT NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER NOT NULL DEFAULT 0,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "purchaseValueMinor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "AdInsightDaily_pkey" PRIMARY KEY ("campaignId","date")
);

-- CreateTable
CREATE TABLE "AdAlert" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "campaignId" TEXT,
    "kind" "AdAlertKind" NOT NULL,
    "objectKey" TEXT NOT NULL,
    "detail" JSONB,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AdAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdAccount_clientId_idx" ON "AdAccount"("clientId");

-- CreateIndex
CREATE INDEX "AdAccount_status_lastSyncAt_idx" ON "AdAccount"("status", "lastSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdAccount_agencyId_externalId_key" ON "AdAccount"("agencyId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "AdCampaign_adAccountId_externalId_key" ON "AdCampaign"("adAccountId", "externalId");

-- CreateIndex
CREATE INDEX "AdInsightDaily_date_idx" ON "AdInsightDaily"("date");

-- CreateIndex
CREATE INDEX "AdAlert_agencyId_resolvedAt_idx" ON "AdAlert"("agencyId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdAlert_adAccountId_kind_objectKey_key" ON "AdAlert"("adAccountId", "kind", "objectKey");

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdInsightDaily" ADD CONSTRAINT "AdInsightDaily_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAlert" ADD CONSTRAINT "AdAlert_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAlert" ADD CONSTRAINT "AdAlert_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAlert" ADD CONSTRAINT "AdAlert_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAlert" ADD CONSTRAINT "AdAlert_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

