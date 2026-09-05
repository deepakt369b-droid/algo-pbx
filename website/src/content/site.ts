// Copy for the landing page. Every feature claim here is drawn from what
// the app actually implements (ALGO_PBX_MASTER_DOC.md §2, the CRM/pipeline
// schema, the WhatsApp sidecar, manager-merge conferencing) — nothing
// invented. Kept as data so /docs and the landing page can share phrasing
// without duplicating prose.

export const contactEmail = "algopbx@saharatechs.com";

export const features = [
  {
    title: "PBX for distributed teams",
    body: "Browser-based softphones over WebRTC — no desk phones or SIP hardware to provision. Agents get a dial pad, call controls (mute, hold, transfer), and live status; supervisors get a real-time wallboard, queue routing, and listen-in/whisper/barge for coaching.",
  },
  {
    title: "Your gateway, your numbers",
    body: "Algo PBX runs against a GSM gateway and SIM cards you own and control, reached over an encrypted tunnel. We never sell minutes, SIM cards, or carrier service — the telecom relationship and its regulatory compliance stay yours.",
  },
  {
    title: "CRM built around the phone",
    body: "Contacts, companies, and a Kanban deal pipeline, with every call and WhatsApp message landing on a unified activity timeline. Screen-pop and auto-disposition mean agents work from context, not a blank dial pad.",
  },
  {
    title: "WhatsApp and SMS in one inbox",
    body: "Customer conversations — WhatsApp threads, voice notes, images, SMS — sit alongside call history on the same contact record, so a handoff between channels doesn't mean starting over.",
  },
  {
    title: "Call recording, on your terms",
    body: "Recordings are retained for a fixed, configurable window and then permanently deleted by an automated retention job — never kept indefinitely by default.",
  },
  {
    title: "Manager-merge conferencing",
    body: "A supervisor can merge into a live call to join or coach directly, on top of the existing listen-in/whisper controls — for the moments coaching needs a real third voice, not just an ear.",
  },
];

export const pricing = {
  planName: "Standard",
  priceAed: 500,
  seatsIncluded: 4,
  billingNote: "Manual invoicing — no card required, no self-serve checkout.",
  bullets: [
    "4 agent seats included",
    "Full PBX, CRM, and WhatsApp/SMS inbox",
    "Call recording with configurable retention",
    "Additional seats available on request",
  ],
};

export const faq = [
  {
    q: "Do you sell SIM cards, phone numbers, or carrier minutes?",
    a: "No. Algo PBX is software only. You bring your own GSM gateway, SIM cards, and carrier contracts; we host and run the PBX, CRM, and messaging software on top of them.",
  },
  {
    q: "Who is responsible for telecom regulatory compliance?",
    a: "You are, for the lines and numbers you control. We provide Do-Not-Call list tooling and call-recording controls to help, but the carrier relationship and its regulatory obligations belong to you.",
  },
  {
    q: "How does the pricing work?",
    a: "One plan: AED 500 per month, including 4 seats, invoiced manually. There is no self-serve signup yet — contact us and we'll get you onboarded.",
  },
  {
    q: "How do you access our data or system for support?",
    a: "Only through time-boxed, reasoned support grants that expire automatically and are logged — never standing access. See our Privacy Policy for the exact mechanism.",
  },
  {
    q: "What happens to our data if we cancel?",
    a: "Suspension never auto-deletes data. See our Terms of Service for the exact policy.",
  },
];

export const howItWorksSteps = [
  {
    title: "Your gateway and SIMs",
    body: "A GSM gateway you own, on your premises, with your SIM cards and carrier contracts.",
  },
  {
    title: "Encrypted tunnel",
    body: "An encrypted VPN tunnel connects your gateway to our hosted platform — signaling and media never cross the public internet in the clear.",
  },
  {
    title: "Our cloud software",
    body: "Asterisk-based PBX, CRM, and messaging, hosted and maintained by us, running against your telecom connection.",
  },
  {
    title: "Your agents, anywhere",
    body: "Agents sign in from a browser — WebRTC softphone, dial pad, CRM, and WhatsApp inbox in one workspace, wherever they're located.",
  },
];
