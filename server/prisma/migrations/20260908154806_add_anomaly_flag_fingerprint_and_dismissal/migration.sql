-- AlterTable
ALTER TABLE "AnomalyFlag" ADD COLUMN     "dismissedAt" TIMESTAMP(3),
ADD COLUMN     "fingerprint" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AnomalyFlag_userId_fingerprint_key" ON "AnomalyFlag"("userId", "fingerprint");

