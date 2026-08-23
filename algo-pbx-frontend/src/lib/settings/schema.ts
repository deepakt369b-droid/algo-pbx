import { z } from "zod";

// The single declaration point for every runtime-configurable setting.
// GET/PATCH /api/admin/settings and src/app/admin/settings/page.tsx both
// derive their shape from this table — adding a new setting is a
// one-line addition here, not three separate edits kept in sync by hand.
//
// `envFallback` names the process.env var this setting used to be read
// from exclusively (see src/lib/settings/service.ts's resolution order:
// DB row -> that env var -> `default`). Existing .env-based deployments
// keep working unchanged; the DB only needs a row once an admin actually
// edits a value in the UI.

export type SettingSection =
  | "email"
  | "whatsapp_openwa"
  | "whatsapp_meta"
  | "sms_dinstar"
  | "otp"
  | "firebase"
  | "crm";

export interface SettingDef {
  key: string;
  section: SettingSection;
  label: string;
  help?: string;
  secret: boolean;
  envFallback?: string;
  default?: string;
  validator: z.ZodTypeAny;
}

export const SETTINGS_REGISTRY: SettingDef[] = [
  // --- Email (Resend) ---
  {
    key: "RESEND_API_KEY",
    section: "email",
    label: "Resend API Key",
    help: "https://resend.com/api-keys — used only to deliver agent invite emails.",
    secret: true,
    envFallback: "RESEND_API_KEY",
    validator: z.string().min(1),
  },
  {
    key: "INVITE_FROM_EMAIL",
    section: "email",
    label: "Invite From Address",
    secret: false,
    envFallback: "INVITE_FROM_EMAIL",
    default: "invites@algopbx.local",
    validator: z.string().email(),
  },

  // --- WhatsApp: OpenWA ---
  {
    key: "OPENWA_BASE_URL",
    section: "whatsapp_openwa",
    label: "OpenWA Base URL",
    secret: false,
    envFallback: "OPENWA_BASE_URL",
    default: "http://openwa:2785",
    validator: z.string().url(),
  },
  {
    key: "OPENWA_API_KEY",
    section: "whatsapp_openwa",
    label: "OpenWA API Key",
    secret: true,
    envFallback: "OPENWA_API_KEY",
    validator: z.string().min(1),
  },
  {
    key: "OPENWA_WEBHOOK_SECRET",
    section: "whatsapp_openwa",
    label: "OpenWA Webhook Shared Secret",
    help: "Must match the value configured on the OpenWA sidecar's outbound webhook.",
    secret: true,
    envFallback: "OPENWA_WEBHOOK_SECRET",
    validator: z.string().min(1),
  },

  // --- WhatsApp: Meta Cloud API ---
  {
    key: "META_WABA_TOKEN",
    section: "whatsapp_meta",
    label: "Meta WABA Access Token",
    secret: true,
    envFallback: "META_WABA_TOKEN",
    validator: z.string().min(1),
  },
  {
    key: "META_PHONE_NUMBER_ID",
    section: "whatsapp_meta",
    label: "Meta Phone Number ID",
    secret: false,
    envFallback: "META_PHONE_NUMBER_ID",
    validator: z.string().min(1),
  },

  // --- SMS: Dinstar UC2000 ---
  {
    key: "DINSTAR_LAN_IP",
    section: "sms_dinstar",
    label: "Dinstar Gateway Address",
    help: "Host or origin reachable over the Tailscale route the voice trunk already uses.",
    secret: false,
    envFallback: "DINSTAR_LAN_IP",
    validator: z.string().min(1),
  },
  {
    key: "DINSTAR_SMS_USERNAME",
    section: "sms_dinstar",
    label: "Dinstar Admin Username",
    secret: false,
    envFallback: "DINSTAR_SMS_USERNAME",
    validator: z.string().min(1),
  },
  {
    key: "DINSTAR_SMS_PASSWORD",
    section: "sms_dinstar",
    label: "Dinstar Admin Password",
    secret: true,
    envFallback: "DINSTAR_SMS_PASSWORD",
    validator: z.string().min(1),
  },

  // --- OTP routing ---
  {
    key: "OTP_CHANNEL",
    section: "otp",
    label: "OTP Delivery Channel",
    help: "Which channel sends verification codes for agent registration and login 2FA.",
    secret: false,
    default: "OPENWA",
    validator: z.enum(["OPENWA", "META_CLOUD", "FIREBASE"]),
  },
  {
    key: "OTP_WA_INSTANCE_ID",
    section: "otp",
    label: "OTP WhatsApp Instance",
    help: "Which paired WaInstance sends OTPs when the channel is OpenWA — leave blank to use the first available instance. Dedicate one SIM here to isolate OTP traffic from customer messaging.",
    secret: false,
    validator: z.string().optional(),
  },
  {
    key: "WHATSAPP_OTP_TEMPLATE_NAME",
    section: "otp",
    label: "Meta OTP Template Name",
    help: "Only used when OTP_CHANNEL is META_CLOUD — must be a pre-approved authentication-category template.",
    secret: false,
    envFallback: "WHATSAPP_OTP_TEMPLATE_NAME",
    default: "agent_otp_verification",
    validator: z.string().min(1),
  },
  {
    key: "WHATSAPP_OTP_TEMPLATE_LANG",
    section: "otp",
    label: "Meta OTP Template Language",
    secret: false,
    envFallback: "WHATSAPP_OTP_TEMPLATE_LANG",
    default: "en",
    validator: z.string().min(1),
  },

  // --- Firebase (optional OTP fallback) ---
  {
    key: "NEXT_PUBLIC_FIREBASE_API_KEY",
    section: "firebase",
    label: "Firebase API Key",
    help: "Not a secret — identifies the Firebase project, does not authorize anything.",
    secret: false,
    envFallback: "NEXT_PUBLIC_FIREBASE_API_KEY",
    validator: z.string().min(1),
  },
  {
    key: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    section: "firebase",
    label: "Firebase Auth Domain",
    secret: false,
    envFallback: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    validator: z.string().min(1),
  },
  {
    key: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    section: "firebase",
    label: "Firebase Project ID",
    secret: false,
    envFallback: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    validator: z.string().min(1),
  },
  {
    key: "FIREBASE_SERVICE_ACCOUNT_JSON",
    section: "firebase",
    label: "Firebase Service Account (JSON)",
    help: "The full service-account key file contents. This IS the actual secret — never sent to the browser.",
    secret: true,
    envFallback: "FIREBASE_SERVICE_ACCOUNT_JSON",
    validator: z.string().refine((v) => {
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    }, "Must be valid JSON"),
  },

  // --- CRM ---
  {
    key: "CRM_WEBHOOK_SECRET",
    section: "crm",
    label: "CRM Webhook Signing Secret",
    help: "Shared HMAC secret used when a WebhookSubscription row has no per-subscription secret of its own.",
    secret: true,
    envFallback: "CRM_WEBHOOK_SECRET",
    validator: z.string().min(1),
  },
];

export function getSettingDef(key: string): SettingDef | undefined {
  return SETTINGS_REGISTRY.find((s) => s.key === key);
}
