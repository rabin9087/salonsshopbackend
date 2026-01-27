/*
  Warnings:

  - You are about to drop the column `max_capacity` on the `services` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "salons" ADD COLUMN     "default_slot_capacity" INTEGER NOT NULL DEFAULT 4;

-- AlterTable
ALTER TABLE "services" DROP COLUMN "max_capacity",
ADD COLUMN     "show_price" BOOLEAN NOT NULL DEFAULT true;
