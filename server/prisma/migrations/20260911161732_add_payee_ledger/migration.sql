-- CreateEnum
CREATE TYPE "PayeeType" AS ENUM ('PERSON', 'BUSINESS');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "payeeId" TEXT;

-- CreateTable
CREATE TABLE "Payee" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "upiVpa" TEXT,
    "phone" TEXT,
    "type" "PayeeType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payee_userId_idx" ON "Payee"("userId");

-- CreateIndex
CREATE INDEX "Payee_userId_displayName_idx" ON "Payee"("userId", "displayName");

-- CreateIndex
CREATE UNIQUE INDEX "Payee_userId_upiVpa_key" ON "Payee"("userId", "upiVpa");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payee" ADD CONSTRAINT "Payee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
