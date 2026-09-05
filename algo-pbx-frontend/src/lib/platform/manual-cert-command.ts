// The manual certificate-signing instructions the provisioning wizard prints
// at its human gate.
//
// Every string here is drawn from the ACTUAL first cert issuance
// (cust-demo-gw-1, recorded in handoff.md and LLM.md §"First client cert
// issued") and from bridge-watch.sh's own refusal message — not invented.
// That matters: an operator following a plausible-looking but wrong command
// at 2am, against a passphrase-protected CA, produces exactly the
// half-created PKI state that took a live debugging session to untangle the
// first time.
//
// Two real failure modes were hit issuing that first cert, and both are
// reproduced as warnings below rather than left for the next person to
// rediscover:
//   - `build-client-full` refuses a retry with "Request file already exists"
//     if a previous attempt left a key/req behind; the surgical fix is
//     `easyrsa sign-req client <cn>`, which reuses them and re-does only the
//     signing step.
//   - `ovpn_getclient <cn> nopass` is wrong — `nopass` is
//     `build-client-full`'s argument. The correct form is
//     `ovpn_getclient <cn> combined`.
//
// Pure: builds strings, runs nothing.

/** The compose service's container_name in docker-compose.yml. */
export const OPENVPN_CONTAINER = "algo-openvpn-server";

export interface ManualCertCommand {
  /** Ordered shell commands, ready to copy. */
  commands: string[];
  /** The one-line "what this does" shown above the block. */
  intro: string;
  /** Things that will bite if ignored — each learned the hard way. */
  warnings: string[];
  /** What the wizard checks for before it will let the operator continue. */
  expectedArtifact: string;
}

/**
 * Builds the manual signing instructions for a gateway certificate.
 *
 * `certCn` is simultaneously the cert CN, the ccd filename and
 * GatewaySite.name — pass the value from `subnet.ts`'s `certCn()`, never a
 * hand-assembled string.
 */
export function buildEasyRsaCommand(certCn: string): ManualCertCommand {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(certCn)) {
    // Same SAFE_NAME_RE bridge-watch.sh enforces. Refusing here stops a bad
    // name reaching a shell command an operator is about to paste as root.
    throw new Error(
      `Refusing to build a signing command for "${certCn}": the CN must match ^[A-Za-z0-9_-]{1,64}$.`
    );
  }

  return {
    intro:
      `Certificate signing is deliberately manual: the CA key is passphrase-protected, and ` +
      `unattended signing stays disabled until CA signing flow v2 ships. Run these on the ` +
      `OpenVPN host, then confirm below.`,
    commands: [
      `docker exec -it ${OPENVPN_CONTAINER} easyrsa build-client-full ${certCn} nopass`,
      `docker exec -it ${OPENVPN_CONTAINER} ovpn_getclient ${certCn} combined > ${certCn}.ovpn`,
    ],
    warnings: [
      "You will be prompted for the CA passphrase. Only the CA key is passphrase-protected — the client key stays nopass, which is what the trailing `nopass` argument means.",
      'A mistyped passphrase fails with "bad decrypt" / "unable to load Private Key". That is the entry being wrong, not the CA key being damaged — simply retry.',
      'If the first command refuses with "Request file already exists", a previous attempt left the key and request behind. Do not delete them: run `docker exec -it ' +
        OPENVPN_CONTAINER +
        " easyrsa sign-req client " +
        certCn +
        "` instead, which reuses them and re-does only the signing step.",
      "`nopass` belongs to build-client-full, not to ovpn_getclient. `ovpn_getclient <cn> nopass` is invalid — the second command takes `combined`.",
      "-it is required: both commands are interactive. Without a TTY they hang on the passphrase prompt with no output.",
    ],
    expectedArtifact: `/etc/openvpn/pki/issued/${certCn}.crt`,
  };
}

/** Flattened copy-paste block for the UI's clipboard button. */
export function copyableCommandBlock(certCn: string): string {
  return buildEasyRsaCommand(certCn).commands.join("\n");
}
