"use client";

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, RecaptchaVerifier, signInWithPhoneNumber, type ConfirmationResult } from "firebase/auth";

// Client-side Firebase init for phone OTP ONLY (registration's primary
// verification path — see src/lib/firebase/admin.ts's header for the
// full picture and why this never becomes the app's actual auth system).
// All config here is NEXT_PUBLIC_ — Firebase's client config is not a
// secret (it identifies the project, not a credential); the real secret
// is the service-account key used server-side in admin.ts, which never
// reaches the browser.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

function app() {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

let recaptchaVerifier: RecaptchaVerifier | null = null;

/** Invisible reCAPTCHA bound to a container element — required by
 * Firebase Phone Auth to prevent SMS-pumping abuse of the free tier.
 * Created once and reused across calls in the same page session. */
function getRecaptchaVerifier(containerId: string): RecaptchaVerifier {
  if (!recaptchaVerifier) {
    recaptchaVerifier = new RecaptchaVerifier(getAuth(app()), containerId, { size: "invisible" });
  }
  return recaptchaVerifier;
}

/**
 * Begin phone verification: sends an SMS via Firebase to `phoneE164`.
 * Returns a ConfirmationResult whose `.confirm(code)` method — called
 * once the agent types the code — resolves to a UserCredential carrying
 * the ID token that must be POSTed to the server for real verification
 * (src/app/api/register/verify-phone/route.ts). Never trust anything in
 * this browser-side result as "verified" on its own.
 */
export async function startFirebasePhoneVerification(
  phoneE164: string,
  recaptchaContainerId: string
): Promise<ConfirmationResult> {
  const auth = getAuth(app());
  const verifier = getRecaptchaVerifier(recaptchaContainerId);
  return signInWithPhoneNumber(auth, phoneE164, verifier);
}

export function resetRecaptcha(): void {
  recaptchaVerifier?.clear();
  recaptchaVerifier = null;
}
