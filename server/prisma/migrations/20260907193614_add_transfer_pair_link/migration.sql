-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "transferPairId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_transferPairId_key" ON "Transaction"("transferPairId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_transferPairId_fkey" FOREIGN KEY ("transferPairId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

