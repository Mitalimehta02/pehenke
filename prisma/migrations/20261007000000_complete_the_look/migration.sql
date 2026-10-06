-- CreateEnum
CREATE TYPE "AccessoryType" AS ENUM ('earring', 'necklace');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ConvState" ADD VALUE 'LOOK_PICK';
ALTER TYPE "ConvState" ADD VALUE 'LOOK_RUNNING';

-- AlterTable
ALTER TABLE "TryOn" ADD COLUMN     "closeupKey" TEXT,
ADD COLUMN     "lookPrep" JSONB;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "lookId" TEXT,
ADD COLUMN     "lookItems" JSONB,
ADD COLUMN     "lookNeckBare" BOOLEAN;

-- CreateTable
CREATE TABLE "Accessory" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "type" "AccessoryType" NOT NULL,
    "label" TEXT NOT NULL,
    "priceInr" INTEGER,
    "photoKey" TEXT NOT NULL,
    "photoHash" TEXT NOT NULL,
    "photoW" INTEGER NOT NULL,
    "photoH" INTEGER NOT NULL,
    "gateStatus" "GateStatus" NOT NULL DEFAULT 'pending',
    "gateProblems" JSONB,
    "gateAdvice" TEXT,
    "gateBy" TEXT,
    "gateAt" TIMESTAMP(3),
    "cropSuggestion" JSONB,
    "originalKey" TEXT,
    "credit" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Accessory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Look" (
    "id" TEXT NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "tryOnId" TEXT NOT NULL,
    "requestedById" TEXT,
    "necklaceId" TEXT,
    "earringId" TEXT,
    "lipHex" TEXT,
    "lipName" TEXT,
    "status" "TryOnStatus" NOT NULL DEFAULT 'queued',
    "stepHashes" JSONB NOT NULL DEFAULT '[]',
    "units" INTEGER NOT NULL DEFAULT 0,
    "outputKey" TEXT,
    "closeupKey" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Look_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LookStep" (
    "hash" TEXT NOT NULL,
    "tryOnId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "status" "TryOnStatus" NOT NULL DEFAULT 'queued',
    "taskId" TEXT,
    "units" INTEGER NOT NULL DEFAULT 0,
    "outputKey" TEXT,
    "outputHash" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "LookStep_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "accessoryId" TEXT,
    "type" "AccessoryType" NOT NULL,
    "label" TEXT NOT NULL,
    "priceInr" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Accessory_sellerId_photoHash_key" ON "Accessory"("sellerId", "photoHash");

-- CreateIndex
CREATE UNIQUE INDEX "Look_inputsHash_key" ON "Look"("inputsHash");

-- CreateIndex
CREATE INDEX "Look_status_idx" ON "Look"("status");

-- CreateIndex
CREATE INDEX "Look_requestedById_createdAt_idx" ON "Look"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "Look_tryOnId_idx" ON "Look"("tryOnId");

-- CreateIndex
CREATE INDEX "LookStep_tryOnId_idx" ON "LookStep"("tryOnId");

-- CreateIndex
CREATE INDEX "LookStep_status_idx" ON "LookStep"("status");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_lookId_fkey" FOREIGN KEY ("lookId") REFERENCES "Look"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Accessory" ADD CONSTRAINT "Accessory_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Look" ADD CONSTRAINT "Look_tryOnId_fkey" FOREIGN KEY ("tryOnId") REFERENCES "TryOn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Look" ADD CONSTRAINT "Look_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Buyer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Look" ADD CONSTRAINT "Look_necklaceId_fkey" FOREIGN KEY ("necklaceId") REFERENCES "Accessory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Look" ADD CONSTRAINT "Look_earringId_fkey" FOREIGN KEY ("earringId") REFERENCES "Accessory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LookStep" ADD CONSTRAINT "LookStep_tryOnId_fkey" FOREIGN KEY ("tryOnId") REFERENCES "TryOn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

