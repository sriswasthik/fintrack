-- Where the money actually went, as the source named it.
--
-- Both nullable and both added without a default: every existing row predates
-- the adapters that populate them, and inventing a value for those rows would
-- be asserting something nobody recorded.
ALTER TABLE "Transaction" ADD COLUMN "counterpartyRaw" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "upiVpa" TEXT;
