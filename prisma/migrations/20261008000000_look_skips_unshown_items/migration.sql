-- AlterTable
ALTER TABLE "Look" ADD COLUMN     "skipped" JSONB,
ADD COLUMN     "unitsWasted" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "LookStep" ADD COLUMN     "rejection" TEXT,
ADD COLUMN     "unitsWasted" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "shown" BOOLEAN NOT NULL DEFAULT true;

