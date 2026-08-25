-- Initial migration. Hand-written to match prisma/schema.prisma, because
-- this repo previously shipped NO migrations directory at all (only
-- schema.prisma) and no Postgres instance is reachable from the
-- environment this was authored in to run `prisma migrate dev --name init`
-- and let Prisma generate this diff itself. That is the normal and
-- preferred way to produce this file — treat this hand-written version as
-- a starting point to verify (`prisma migrate diff` against a throwaway
-- dev database, or `prisma db push` on a scratch DB and diff the result)
-- before it is trusted as the baseline for any real deployment, and
-- regenerate properly once a dev database is available.

-- Enums
CREATE TYPE "AgentStatus" AS ENUM ('AVAILABLE', 'BUSY', 'BREAK', 'OFFLINE');
CREATE TYPE "Role" AS ENUM ('AGENT', 'SUPERVISOR', 'ADMIN');
CREATE TYPE "MessageChannel" AS ENUM ('WHATSAPP', 'SMS');
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "MessageProviderKind" AS ENUM ('OPENWA', 'META_CLOUD', 'DINSTAR_SMS');
CREATE TYPE "WaInstanceStatus" AS ENUM ('PAIRING', 'CONNECTED', 'DISCONNECTED', 'LOGGED_OUT');
CREATE TYPE "SmsAccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'REVOKED');

-- User
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'AGENT',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_disabled_idx" ON "User"("disabled");

-- LoginAttempt
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoginAttempt_email_ip_key" ON "LoginAttempt"("email", "ip");
CREATE INDEX "LoginAttempt_lockedUntil_idx" ON "LoginAttempt"("lockedUntil");
ALTER TABLE "LoginAttempt" ADD CONSTRAINT "LoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Invite
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invite_userId_key" ON "Invite"("userId");
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");
CREATE INDEX "Invite_expiresAt_idx" ON "Invite"("expiresAt");
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Extension
CREATE TABLE "Extension" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'webrtc',
    "userId" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastSeenAt" TIMESTAMP(3),
    "sipSecret" TEXT,
    "voicemailPin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Extension_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Extension_number_key" ON "Extension"("number");
CREATE UNIQUE INDEX "Extension_userId_key" ON "Extension"("userId");
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Queue
CREATE TABLE "Queue" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'ringall',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Queue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Queue_name_key" ON "Queue"("name");

-- QueueMember
CREATE TABLE "QueueMember" (
    "id" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "penalty" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "QueueMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QueueMember_queueId_extension_key" ON "QueueMember"("queueId", "extension");
ALTER TABLE "QueueMember" ADD CONSTRAINT "QueueMember_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "Queue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CallDetailRecord
CREATE TABLE "CallDetailRecord" (
    "id" TEXT NOT NULL,
    "uniqueId" TEXT NOT NULL,
    "callerNumber" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "billsecSec" INTEGER NOT NULL DEFAULT 0,
    "recordingUrl" TEXT,
    "queueName" TEXT,
    "agentExtension" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallDetailRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CallDetailRecord_uniqueId_key" ON "CallDetailRecord"("uniqueId");
CREATE INDEX "CallDetailRecord_startedAt_idx" ON "CallDetailRecord"("startedAt");
CREATE INDEX "CallDetailRecord_agentExtension_idx" ON "CallDetailRecord"("agentExtension");

-- DoNotCallEntry
CREATE TABLE "DoNotCallEntry" (
    "id" TEXT NOT NULL,
    "numberE164" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DoNotCallEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DoNotCallEntry_numberE164_key" ON "DoNotCallEntry"("numberE164");
ALTER TABLE "DoNotCallEntry" ADD CONSTRAINT "DoNotCallEntry_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Recording
CREATE TABLE "Recording" (
    "id" TEXT NOT NULL,
    "cdrId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSizeBytes" INTEGER,
    "hiddenFromAgentAt" TIMESTAMP(3),
    "hiddenByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Recording_cdrId_idx" ON "Recording"("cdrId");
CREATE INDEX "Recording_hiddenFromAgentAt_idx" ON "Recording"("hiddenFromAgentAt");
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_cdrId_fkey" FOREIGN KEY ("cdrId") REFERENCES "CallDetailRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_hiddenByUserId_fkey" FOREIGN KEY ("hiddenByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AuditLog
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CallQualitySample
CREATE TABLE "CallQualitySample" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "extension" TEXT,
    "jitterMs" DOUBLE PRECISION,
    "packetsLost" INTEGER,
    "packetsReceived" INTEGER,
    "roundTripTimeMs" DOUBLE PRECISION,
    "jitterBufferDelayMs" DOUBLE PRECISION,
    "mosEstimate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallQualitySample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CallQualitySample_callId_idx" ON "CallQualitySample"("callId");
CREATE INDEX "CallQualitySample_createdAt_idx" ON "CallQualitySample"("createdAt");

-- WaInstance
CREATE TABLE "WaInstance" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "simPort" INTEGER NOT NULL,
    "phoneE164" TEXT,
    "provider" "MessageProviderKind" NOT NULL DEFAULT 'OPENWA',
    "status" "WaInstanceStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "pairedByAdminId" TEXT,
    "lastConnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WaInstance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WaInstance_label_key" ON "WaInstance"("label");
CREATE UNIQUE INDEX "WaInstance_simPort_key" ON "WaInstance"("simPort");
ALTER TABLE "WaInstance" ADD CONSTRAINT "WaInstance_pairedByAdminId_fkey" FOREIGN KEY ("pairedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Contact
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "numberE164" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Contact_numberE164_key" ON "Contact"("numberE164");

-- Conversation
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "waInstanceId" TEXT,
    "assignedAgentId" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Conversation_contactId_channel_waInstanceId_key" ON "Conversation"("contactId", "channel", "waInstanceId");
CREATE INDEX "Conversation_assignedAgentId_idx" ON "Conversation"("assignedAgentId");
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_waInstanceId_fkey" FOREIGN KEY ("waInstanceId") REFERENCES "WaInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ChatMessage
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT,
    "mediaUrl" TEXT,
    "mediaMimeType" TEXT,
    "providerMessageId" TEXT,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");
CREATE INDEX "ChatMessage_providerMessageId_idx" ON "ChatMessage"("providerMessageId");
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SmsAccessRequest
CREATE TABLE "SmsAccessRequest" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "SmsAccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SmsAccessRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SmsAccessRequest_status_idx" ON "SmsAccessRequest"("status");
CREATE INDEX "SmsAccessRequest_requestedById_idx" ON "SmsAccessRequest"("requestedById");
ALTER TABLE "SmsAccessRequest" ADD CONSTRAINT "SmsAccessRequest_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SmsAccessRequest" ADD CONSTRAINT "SmsAccessRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SmsAccessRequest" ADD CONSTRAINT "SmsAccessRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
