import { cert, deleteApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getSetting, onSettingChanged } from "@/lib/settings/service";

// Server-side Firebase Admin SDK — used for EXACTLY ONE THING: verifying
// the ID token a client receives after completing
// signInWithPhoneNumber()/confirmationResult.confirm() in the browser
// (see src/lib/firebase/client.ts and src/app/register/page.tsx). This
// is the security-critical half of phone verification: the client's own
// claim that verification succeeded is NEVER trusted on its own — only
// a token that verifyIdToken() accepts as genuinely signed by Google,
// with a `phone_number` claim matching the number being registered,
// counts.
//
// Firebase is NOT used as this app's authentication system. No Firebase
// session, cookie, or user record is created here — NextAuth
// (src/auth.ts) remains the sole source of truth for "who is signed
// in." This file's only export is a phone-verification oracle.
//
// FIREBASE_SERVICE_ACCOUNT_JSON is admin-configurable via
// /admin/settings, so the initialized App instance must be torn down and
// rebuilt if that setting changes — a stale App would keep verifying
// tokens against the OLD service account's project after an admin
// rotated it, which is a much worse failure than "not configured yet."

let app: App | null = null;

onSettingChanged(["FIREBASE_SERVICE_ACCOUNT_JSON"], () => {
  if (app) {
    deleteApp(app).catch(() => undefined);
    app = null;
  }
});

async function ensureApp(): Promise<App> {
  if (app) return app;
  if (getApps().length > 0) {
    // A previous, now-orphaned default app from before a settings change
    // — tear it down rather than reusing it, since we can't tell whether
    // it was built from the current credential.
    await Promise.all(getApps().map((a) => deleteApp(a).catch(() => undefined)));
  }

  const raw = await getSetting("FIREBASE_SERVICE_ACCOUNT_JSON");
  if (!raw) {
    throw new Error(
      "Firebase is not configured — set the service account JSON in /admin/settings (or FIREBASE_SERVICE_ACCOUNT_JSON) before using phone verification."
    );
  }
  const serviceAccount = JSON.parse(raw);
  app = initializeApp({ credential: cert(serviceAccount) });
  return app;
}

export interface VerifiedPhoneToken {
  uid: string;
  phoneE164: string;
}

/**
 * Verify a Firebase ID token and return the phone number Google attests
 * was actually verified via SMS OTP. Throws on any invalid/expired/
 * forged token — callers must not swallow that into a generic "ok:
 * false", since a forged-token path is exactly what an attacker would
 * probe for silent failure on.
 */
export async function verifyFirebasePhoneToken(idToken: string): Promise<VerifiedPhoneToken> {
  const firebaseApp = await ensureApp();
  const decoded = await getAuth(firebaseApp).verifyIdToken(idToken);
  const phoneNumber = decoded.phone_number;
  if (!phoneNumber || typeof phoneNumber !== "string") {
    throw new Error("Firebase token does not carry a verified phone_number claim.");
  }
  return { uid: decoded.uid, phoneE164: phoneNumber };
}
