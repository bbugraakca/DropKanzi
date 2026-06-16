/*
  Warnings:

  - Made the column `lineItemId` on the `Order` table required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
UPDATE "Order" SET "lineItemId" = 'NO_LINE_ITEM' WHERE "lineItemId" IS NULL;
ALTER TABLE "Order" ALTER COLUMN "lineItemId" SET NOT NULL;
