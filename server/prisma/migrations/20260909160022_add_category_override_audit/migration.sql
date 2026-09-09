-- CreateTable
CREATE TABLE "CategoryOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "fromCategory" "Category" NOT NULL,
    "toCategory" "Category" NOT NULL,
    "learnedRule" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategoryOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CategoryOverride_userId_createdAt_idx" ON "CategoryOverride"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CategoryOverride_transactionId_idx" ON "CategoryOverride"("transactionId");

-- AddForeignKey
ALTER TABLE "CategoryOverride" ADD CONSTRAINT "CategoryOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryOverride" ADD CONSTRAINT "CategoryOverride_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

