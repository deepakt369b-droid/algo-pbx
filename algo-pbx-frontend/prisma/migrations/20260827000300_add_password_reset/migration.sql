-- Self-service + admin-triggered password reset (Loop C3). Hand-written,
-- same live-Postgres-diff caveat as every other migration in this repo.
-- Append-only: adds one enum value and one nullable column, touches no
-- existing data.

-- AlterEnum
ALTER TYPE "OtpPurpose" ADD VALUE 'PASSWORD_RESET';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
