-- Agent registration, phone verification (Firebase primary / WhatsApp
-- fallback), login 2FA scaffolding, and sign-in-feed support columns.
-- Hand-written in the same style as every other migration in this
-- project (see 20260823000000_init's header) — verify with
-- `prisma migrate diff` against a throwaway dev database before trusting
-- this as a deploy baseline; no Postgres is reachable from the
-- environment this was authored in.

-- Enums
CREATE TYPE "OtpPurpose" AS ENUM ('PHONE_VERIFICATION', 'LOGIN_2FA');
CREATE TYPE "OtpChannel" AS ENUM ('WHATSAPP', 'SMS');

-- User: new columns
ALTER TABLE "User"
  ADD COLUMN "phoneE164" TEXT,
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "phoneVerifiedByAdminId" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "photoPath" TEXT,
  ADD COLUMN "profileCompletedAt" TIMESTAMP(3),
  ADD COLUMN "signInFeedSeenAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_phoneE164_key" ON "User"("phoneE164");
CREATE INDEX "User_profileCompletedAt_idx" ON "User"("profileCompletedAt");

ALTER TABLE "User" ADD CONSTRAINT "User_phoneVerifiedByAdminId_fkey"
  FOREIGN KEY ("phoneVerifiedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- OtpChallenge
CREATE TABLE "OtpChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "channel" "OtpChannel" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OtpChallenge_userId_purpose_createdAt_idx" ON "OtpChallenge"("userId", "purpose", "createdAt");
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "OtpChallenge"("expiresAt");
ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- TrustedDevice
CREATE TABLE "TrustedDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "lastSeenIp" TEXT,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TrustedDevice_tokenHash_key" ON "TrustedDevice"("tokenHash");
CREATE INDEX "TrustedDevice_userId_idx" ON "TrustedDevice"("userId");
CREATE INDEX "TrustedDevice_expiresAt_idx" ON "TrustedDevice"("expiresAt");
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
