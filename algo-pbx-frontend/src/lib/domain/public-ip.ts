// Detects the outbound public IP the VM is currently seen as — used to
// pre-fill the A-record step. Two providers, short timeout, first success
// wins; brief in-memory cache since this rarely changes within a session
// and the wizard polls its status endpoint repeatedly.
let cached: { ip: string; at: number } | null = null;
const CACHE_MS = 60_000;

const PROVIDERS = ["https://api.ipify.org?format=text", "https://ifconfig.me/ip"];

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export async function detectPublicIp(): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.ip;

  for (const url of PROVIDERS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (IPV4_RE.test(text)) {
        cached = { ip: text, at: Date.now() };
        return text;
      }
    } catch {
      // try the next provider
    }
  }
  return null;
}
