// Seed content for /docs. Sourced from ALGO_PBX_MASTER_DOC.md §2-3 and
// DEPLOYMENT.md's own structure — describes the real deployment model, not
// an aspiration. Structured as sections so the page can grow without
// touching layout.

export const docsSections = [
  {
    title: "What Algo PBX is",
    body: "Algo PBX is a self-hosted phone system: browser-based WebRTC softphones for your agents, a CRM and messaging inbox, and call routing that runs against a GSM gateway and SIM cards you own. It replaces a proprietary PBX (like 3CX) without asking you to give up control of your telecom lines.",
  },
  {
    title: "The deployment model",
    body: "Your GSM gateway sits on your premises, connected to your SIM cards and carrier lines. It reaches our hosted platform over an encrypted tunnel — signaling and media never travel over the public internet unencrypted. We run and maintain the PBX engine, web application, and database; you keep ownership of the gateway hardware and the telecom contracts behind it.",
  },
  {
    title: "Onboarding steps",
    body: "1. Contact us to discuss your gateway model and SIM setup.\n2. We provision your tenant and issue tunnel credentials for your gateway.\n3. You configure the tunnel on your gateway using the guide we provide.\n4. We verify the connection and register your numbers.\n5. Your agents sign in from a browser — no desk phone or SIP client to install.",
  },
  {
    title: "Agent workspace",
    body: "Agents get a WebRTC dial pad, incoming-call popup with caller ID, mute/hold/transfer controls, and a status selector (Available / Busy / On Break / Offline). Calls and messages land on the same CRM contact record automatically.",
  },
  {
    title: "Supervisor tools",
    body: "Admins see a real-time wallboard of active calls and agent availability, can listen in, whisper-coach, or merge into a live call, and manage queues and ring groups (round-robin, least-recent, ring-all). Call detail records are searchable with audio playback.",
  },
  {
    title: "FAQ",
    body: "See the main FAQ on the home page for billing, data, and support-access questions. For anything gateway- or deployment-specific not covered here, contact us directly.",
  },
];
