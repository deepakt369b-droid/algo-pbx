import { generateKeyPairSync } from "node:crypto";

// Real X25519 keypair generation for per-user WireGuard profiles
// (owner-page enchanted-sphinx plan, W3) — NOT a placeholder. Node's
// `crypto.generateKeyPairSync("x25519", ...)` produces a genuine Curve25519
// keypair; WireGuard's own key format is just the raw 32-byte scalar,
// base64-encoded, so this strips the fixed DER envelope
// (SPKI adds a 12-byte prefix, PKCS8 a 16-byte prefix — both are constant
// for x25519, hence the fixed slice) to get the same bytes `wg genkey` /
// `wg pubkey` would produce. The private key this returns is real key
// material usable by an actual WireGuard client against a real peer at the
// configured endpoint — this app just has no way to verify the resulting
// handshake itself (same limitation `transports/wireguard.ts`'s `probe()`
// already states plainly for GatewaySite-level WireGuard).
export function generateWireguardKeypair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    privateKey: privateKey.subarray(privateKey.length - 32).toString("base64"),
    publicKey: publicKey.subarray(publicKey.length - 32).toString("base64"),
  };
}
