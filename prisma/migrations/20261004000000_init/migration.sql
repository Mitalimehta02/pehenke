-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('upper_body', 'full_body');

-- CreateEnum
CREATE TYPE "PhotoType" AS ENUM ('flatlay', 'hanger', 'mannequin', 'worn');

-- CreateEnum
CREATE TYPE "GarmentLength" AS ENUM ('crop', 'waist', 'hip', 'knee', 'ankle', 'floor');

-- CreateEnum
CREATE TYPE "GateStatus" AS ENUM ('pending', 'approved', 'needs_review', 'rejected');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('web', 'whatsapp');

-- CreateEnum
CREATE TYPE "ConvState" AS ENUM ('NEW', 'AWAIT_CONSENT', 'AWAIT_PHOTO', 'PICK_GARMENT', 'TRYON_RUNNING', 'PREVIEW', 'AWAIT_SELLER', 'ORDERED', 'DECLINED');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "TryOnStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'lost');

-- CreateEnum
CREATE TYPE "CardVerdict" AS ENUM ('send', 'send_with_disclosure', 'block');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('pending_seller', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "OrderOutcome" AS ENUM ('pending', 'delivered', 'refused', 'cancelled');

-- CreateEnum
CREATE TYPE "Framing" AS ENUM ('full', 'chest', 'unknown');

-- CreateTable
CREATE TABLE "Blob" (
    "key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Blob_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Seller" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessKeyHash" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Garment" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "photoType" "PhotoType" NOT NULL,
    "length" "GarmentLength",
    "priceInr" INTEGER,
    "includesBlouse" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "photoKey" TEXT NOT NULL,
    "photoHash" TEXT NOT NULL,
    "photoW" INTEGER NOT NULL,
    "photoH" INTEGER NOT NULL,
    "gateStatus" "GateStatus" NOT NULL DEFAULT 'pending',
    "gateProblems" JSONB,
    "gateAdvice" TEXT,
    "gateBy" TEXT,
    "gateAt" TIMESTAMP(3),
    "sellerConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "credit" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Garment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Buyer" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Buyer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerPhoto" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT,
    "sellerId" TEXT,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "sampleName" TEXT,
    "credit" JSONB,
    "blobKey" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "framing" "Framing" NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "state" "ConvState" NOT NULL DEFAULT 'NEW',
    "context" JSONB NOT NULL DEFAULT '{}',
    "activeTryOnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "kind" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TryOn" (
    "id" TEXT NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "garmentId" TEXT NOT NULL,
    "buyerPhotoId" TEXT NOT NULL,
    "requestedById" TEXT,
    "category" "Category" NOT NULL,
    "changeShoes" BOOLEAN NOT NULL DEFAULT false,
    "status" "TryOnStatus" NOT NULL DEFAULT 'queued',
    "taskId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "units" INTEGER NOT NULL DEFAULT 0,
    "unitsWasted" INTEGER NOT NULL DEFAULT 0,
    "outputKey" TEXT,
    "outputW" INTEGER,
    "outputH" INTEGER,
    "pixelChecks" JSONB,
    "verdict" "CardVerdict",
    "disclosureText" TEXT,
    "blockReason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TryOn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "garmentId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "tryOnId" TEXT,
    "cardStatus" "CardStatus" NOT NULL DEFAULT 'pending_seller',
    "disclosureText" TEXT,
    "pixelSummary" JSONB,
    "sellerNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "outcome" "OrderOutcome" NOT NULL DEFAULT 'pending',
    "outcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCall" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "units" INTEGER NOT NULL DEFAULT 0,
    "taskId" TEXT,
    "tryOnId" TEXT,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Seller_slug_key" ON "Seller"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Garment_sellerId_photoHash_key" ON "Garment"("sellerId", "photoHash");

-- CreateIndex
CREATE UNIQUE INDEX "Buyer_channel_externalId_key" ON "Buyer"("channel", "externalId");

-- CreateIndex
CREATE INDEX "BuyerPhoto_buyerId_idx" ON "BuyerPhoto"("buyerId");

-- CreateIndex
CREATE INDEX "Conversation_activeTryOnId_idx" ON "Conversation"("activeTryOnId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_sellerId_buyerId_channel_key" ON "Conversation"("sellerId", "buyerId", "channel");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TryOn_inputsHash_key" ON "TryOn"("inputsHash");

-- CreateIndex
CREATE INDEX "TryOn_status_idx" ON "TryOn"("status");

-- CreateIndex
CREATE INDEX "TryOn_requestedById_createdAt_idx" ON "TryOn"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "Order_sellerId_createdAt_idx" ON "Order"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiCall_provider_day_idx" ON "ApiCall"("provider", "day");

-- AddForeignKey
ALTER TABLE "Garment" ADD CONSTRAINT "Garment_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPhoto" ADD CONSTRAINT "BuyerPhoto_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPhoto" ADD CONSTRAINT "BuyerPhoto_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_activeTryOnId_fkey" FOREIGN KEY ("activeTryOnId") REFERENCES "TryOn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TryOn" ADD CONSTRAINT "TryOn_garmentId_fkey" FOREIGN KEY ("garmentId") REFERENCES "Garment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TryOn" ADD CONSTRAINT "TryOn_buyerPhotoId_fkey" FOREIGN KEY ("buyerPhotoId") REFERENCES "BuyerPhoto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TryOn" ADD CONSTRAINT "TryOn_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Buyer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_garmentId_fkey" FOREIGN KEY ("garmentId") REFERENCES "Garment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tryOnId_fkey" FOREIGN KEY ("tryOnId") REFERENCES "TryOn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

