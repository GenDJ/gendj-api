/*
  Warnings:

  - A unique constraint covering the columns `[jobId]` on the table `Warp` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Warp" ADD COLUMN     "jobEndedAt" TIMESTAMP(3),
ADD COLUMN     "jobId" TEXT,
ADD COLUMN     "jobRequestedAt" TIMESTAMP(3),
ADD COLUMN     "jobStartedAt" TIMESTAMP(3),
ADD COLUMN     "jobStatus" TEXT,
ADD COLUMN     "workerId" TEXT,
ALTER COLUMN "podStatus" DROP NOT NULL,
ALTER COLUMN "podStatus" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "Warp_jobId_key" ON "Warp"("jobId");
