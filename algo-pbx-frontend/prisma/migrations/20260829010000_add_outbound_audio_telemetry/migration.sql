-- AlterTable
ALTER TABLE "CallQualitySample" ADD COLUMN "packetsSent" INTEGER;
ALTER TABLE "CallQualitySample" ADD COLUMN "audioLevel" DOUBLE PRECISION;
ALTER TABLE "CallQualitySample" ADD COLUMN "totalAudioEnergy" DOUBLE PRECISION;
