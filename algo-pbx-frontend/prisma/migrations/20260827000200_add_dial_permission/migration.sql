-- Toll-fraud guard (Loop C2). Hand-written, same live-Postgres-diff caveat
-- as every other migration in this repo. Append-only: adds one column with
-- a safe default, touches no existing data.

-- CreateEnum
CREATE TYPE "DialPermission" AS ENUM ('LOCAL', 'NATIONAL', 'INTERNATIONAL');

-- AlterTable
ALTER TABLE "Extension" ADD COLUMN "dialPermission" "DialPermission" NOT NULL DEFAULT 'LOCAL';
