-- AlterEnum
ALTER TYPE "ConvState" ADD VALUE 'AWAIT_PHONE';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "buyerWhatsapp" TEXT,
ADD COLUMN     "cardImageKey" TEXT,
ADD COLUMN     "cardSentAt" TIMESTAMP(3),
ADD COLUMN     "cardToken" TEXT,
ADD COLUMN     "dispatchedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FamilyVote" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tryOnId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "garmentLabel" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FamilyVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyVoteResponse" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "voterKey" TEXT NOT NULL,
    "likes" BOOLEAN NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FamilyVoteResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FamilyVote_token_key" ON "FamilyVote"("token");

-- CreateIndex
CREATE INDEX "FamilyVote_buyerId_idx" ON "FamilyVote"("buyerId");

-- CreateIndex
CREATE INDEX "FamilyVote_expiresAt_idx" ON "FamilyVote"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyVoteResponse_voteId_voterKey_key" ON "FamilyVoteResponse"("voteId", "voterKey");

-- CreateIndex
CREATE UNIQUE INDEX "Order_cardToken_key" ON "Order"("cardToken");

-- AddForeignKey
ALTER TABLE "FamilyVote" ADD CONSTRAINT "FamilyVote_tryOnId_fkey" FOREIGN KEY ("tryOnId") REFERENCES "TryOn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyVote" ADD CONSTRAINT "FamilyVote_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyVote" ADD CONSTRAINT "FamilyVote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyVoteResponse" ADD CONSTRAINT "FamilyVoteResponse_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "FamilyVote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

