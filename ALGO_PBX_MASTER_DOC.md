!z# Algo PBX — Production Blueprint & Engineering Documentation
**Modern, Self-Hosted 3CX Alternative with WebRTC & GSM Gateway Integration**

---

## Table of Contents
- [Table of Contents](#table-of-contents)
- [1. AI Vibe Coding Master Prompt](#1-ai-vibe-coding-master-prompt)
- [2. Product Requirements Document (PRD)](#2-product-requirements-document-prd)
  - [2.1 Overview \& Objective](#21-overview--objective)
  - [2.2 User Personas \& Permissions](#22-user-personas--permissions)
  - [2.3 Non-Functional Requirements](#23-non-functional-requirements)
- [3. System Architecture \& Visualizations](#3-system-architecture--visualizations)
  - [3.1 Network \& Media Topology](#31-network--media-topology)
  - [3.2 Outbound Call Flow](#32-outbound-call-flow)
- [4. Technology Stack](#4-technology-stack)
- [5. Forkable Repositories \& Reference Codebases](#5-forkable-repositories--reference-codebases)
- [6. Production Deployment \& Configuration Files](#6-production-deployment--configuration-files)
  - [6.1 `docker-compose.yml`](#61-docker-composeyml)
  - [6.2 Asterisk Telephony Configurations](#62-asterisk-telephony-configurations)
    - [`/opt/algo-pbx/pbx_configs/pjsip.conf`](#optalgo-pbxpbx_configspjsipconf)
    - [`/opt/algo-pbx/pbx_configs/rtp.conf`](#optalgo-pbxpbx_configsrtpconf)
    - [`/opt/algo-pbx/pbx_configs/extensions.conf`](#optalgo-pbxpbx_configsextensionsconf)
  - [6.3 Tailscale Dinstar Subnet Routing Guide](#63-tailscale-dinstar-subnet-routing-guide)
  - [6.4 Next.js WebRTC Context (`SIPContext.tsx`)](#64-nextjs-webrtc-context-sipcontexttsx)

---

## 1. AI Vibe Coding Master Prompt

> **Usage:** Copy and paste the prompt below into your AI coding tool (Cursor, Windsurf, Claude Code) to initialize and scaffold the entire project.

```text
You are an expert full-stack VoIP engineer and UI/UX designer. We are building "Algo PBX" — a modern, self-hosted, cloud-based 3CX alternative tailored for an inbound/outbound call center.

Core Architecture Constraints:
1. Core PBX Engine: Asterisk 20 (PJSIP) running in Docker with host networking to handle SIP/RTP media seamlessly.
2. WebRTC Client: Next.js 14 (App Router), TypeScript, SIP.js, Tailwind CSS, and Shadcn UI.
3. NAT/Audio Relay: Coturn (STUN/TURN) to guarantee ultra-low latency, zero-packet-loss WebRTC audio between remote agents in India and the cloud PBX.
4. GSM Gateway: Dinstar 4-Port GSM Gateway (UAE Office) bridged to the Cloud VM over a secure Tailscale WireGuard subnet route.
5. Database: PostgreSQL for CDR (Call Detail Records), user authentication, queue configurations, and live agent status.
6. Design Language: Algo IT branding. Dark slate theme (#0B0F19 background), electric cyan (#06B6D4) and vibrant blue (#2563EB) accents, glassmorphic cards, subtle borders, Lottie animations for live call states, and zero generic AI templates.

Follow the PRD, architecture diagrams, and configuration files provided in this repository to implement:
- Phase 1: Docker infrastructure (Asterisk, Coturn, PostgreSQL).
- Phase 2: Next.js WebRTC Softphone module with SIP.js (Register, Make Call, Receive Call, Hold, Mute, Transfer, DTMF keypad).
- Phase 3: Manager/Admin Dashboard (Live call monitoring, Agent state board, CDR logs, Queue management).
- Phase 4: REST API endpoints for Asterisk AMI/ARI management and CDR ingestion.

```

---

## 2. Product Requirements Document (PRD)

### 2.1 Overview & Objective

Algo PBX is an internal telephony solution designed to replace proprietary PBX platforms (like 3CX). It connects remote call center agents in India to local telecom networks in the UAE via an on-premise Dinstar 4-Port GSM Gateway, with ultra-low latency and browser-based WebRTC softphones.

### 2.2 User Personas & Permissions

1. **Agent Workspace:**
* Single-click WebRTC registration on login.
* On-screen dial pad with local/international formatting.
* Incoming call popup with caller ID and auto-answer capability.
* Active call controls: Mute, Hold, Attended/Blind Transfer, Keypad (DTMF).
* Agent Status selector: Available, Busy, On Break, Offline.


2. **Supervisor / Admin Dashboard:**
* Real-time wallboard: Active calls, queue wait times, agent availability.
* Live call intervention: Listen in (Eavesdrop), Whisper (Coach), Barge (Join).
* Queue & Ring Group Manager: Round-robin, Least Recent, Ring All.
* Call Detail Records (CDR) with filtering, duration analytics, and audio playback.
* Extension & Trunk Provisioning (WebRTC users, Grandstream/Yealink IP phones).



### 2.3 Non-Functional Requirements

* **Audio Latency:** Sub-150ms round-trip latency between India agents and UAE telecom networks using G.711a/u and Opus codecs.
* **Reliability:** Auto-reconnect for WebSockets and ICE renegotiation on network drop.
* **Security:** Encrypted WebRTC signaling (WSS), DTLS-SRTP media encryption, isolated SIP trunking over Tailscale VPN.

---

## 3. System Architecture & Visualizations

### 3.1 Network & Media Topology

```mermaid
graph TD
    subgraph UAE_Office [UAE Office Local Network]
        DG[Dinstar 4-Port GSM Gateway\n192.168.1.50]
        LP[Local Office PC\nTailscale Subnet Router]
        DG -- "LAN (SIP UDP 5060)" --> LP
    end

    subgraph Tailscale_Mesh [Encrypted WireGuard Mesh]
        LP -. "Subnet Route: 192.168.1.0/24" .- TS_Cloud[Tailscale Cloud Node]
    end

    subgraph Cloud_Server [Ubuntu Cloud VM]
        TS_Cloud --> Core_PBX[Asterisk 20 PBX Engine\nnetwork_mode: host]
        Core_PBX <--> Coturn[Coturn STUN/TURN\nRTP NAT Traversal]
        Core_PBX <--> PG[(PostgreSQL\nUsers, CDRs, Queues)]
        Web_App[Algo PBX Web App\nNext.js 14 + Nginx] <--> PG
        Web_App <--> Core_PBX
    end

    subgraph Remote_Agents [India Remote Agents]
        Agent1[Agent Browser\nSIP.js WebRTC]
        Agent2[Agent Browser\nSIP.js WebRTC]
    end

    subgraph Hardware_Extensions [Future Hardware Expansion]
        GP[Grandstream IP Phones\nDirect SIP Registration]
    end

    %% Signaling & Media Flows
    Web_App -- "HTTPS / WSS (Port 8089)" --> Agent1 & Agent2
    Coturn -- "SRTP Media (UDP 10000-20000)" --> Agent1 & Agent2
    Core_PBX -- "SIP UDP 5060" --> GP
    Core_PBX == "Routed SIP via Tailscale" ==> DG

```

### 3.2 Outbound Call Flow

```mermaid
sequenceDiagram
    autonumber
    actor Agent as India Agent (Browser)
    participant Web as Next.js WebRTC (SIP.js)
    participant PBX as Asterisk 20 Core
    participant TS as Tailscale Route
    participant Dinstar as Dinstar GSM Gateway
    actor Customer as UAE Customer Phone

    Agent->>Web: Dials UAE Number (+971 50 xxx xxxx)
    Web->>PBX: SIP INVITE via WSS (Opus / G.711)
    PBX->>PBX: Match Dialplan & Authenticate Extension
    PBX->>TS: Forward INVITE to 192.168.1.50:5060
    TS->>Dinstar: Route SIP Packet to Gateway
    Dinstar->>Customer: Places Call via Local UAE SIM Card
    Customer-->>Dinstar: Call Answered (200 OK)
    Dinstar-->>PBX: 200 OK
    PBX-->>Web: 200 OK (DTLS-SRTP Media Established)
    Web-->>Agent: Two-way Audio Connected

```

---

## 4. Technology Stack

| Layer | Component | Choice | Justification |
| --- | --- | --- | --- |
| **Frontend** | Web Framework | **Next.js 14 (App Router)** | High-speed server actions, optimized API routes, modern React ecosystem. |
|  | UI & Styling | **Tailwind CSS + Shadcn UI** | Fully customized dark-slate theme (#0B0F19) with electric cyan/blue gradients. |
|  | WebRTC Engine | **SIP.js v0.20+** | Industry standard for browser SIP over WebSockets with full audio control. |
|  | Icons & Micro-interactions | **Lucide React + Lottie** | Clean iconography and animated call rings/audio wave pulses. |
| **Backend / VoIP** | PBX Engine | **Asterisk 20 LTS** | Enterprise standard, lightweight PJSIP stack, full WebRTC/DTLS support. |
|  | NAT / Media Relay | **Coturn** | Overcomes Symmetric NAT and ISP firewalls for remote agents. |
|  | Database | **PostgreSQL 16** | Relational storage for extensions, active queues, and Call Detail Records. |
|  | ORM | **Prisma / Drizzle** | Type-safe database queries and automated schema migrations. |
| **Networking** | Gateway Mesh | **Tailscale (WireGuard)** | Subnet router bridges the local Dinstar GSM gateway to the cloud without opening public router ports. |
|  | Reverse Proxy | **Nginx** | SSL termination, WSS pass-through, and static Next.js proxying. |
| **Messaging** | WhatsApp engine | **OpenWA** (forked, `vendor/openwa/`) | MIT-licensed, actively maintained; no license-activation gate unlike evolution-go. |
|  | WhatsApp fallback | **Meta Cloud API** | Official API, used when an admin flips a `WaInstance` off OpenWA. |
|  | SMS | **Dinstar UC2000 HTTP/JSON API** | Same SIMs as the voice trunk — same customer-facing number for calls and SMS. |
|  | Agent invites | **Resend** | Single-use, admin-issued invite links; no self-service credential changes for agents. |
|  | CRM connectivity | **Generic HMAC webhooks + REST API** | `/api/crm/*` — provider-neutral substrate for a future named CRM adapter. |
|  | Troubleshooting | **Internal MCP server** (`mcp-server/`, stdio-only) | Read tools unrestricted; write tools gated behind single-use admin-minted approval tokens. |
| **Agent Onboarding** | Phone OTP (default channel) | **OpenWA** (`OTP_CHANNEL=OPENWA`) | Zero external setup — no Meta template approval, no Firebase project. Admin-switchable to Meta Cloud or Firebase from `/admin/settings`, no redeploy. |
|  | Phone OTP (optional channels) | **Meta Cloud API** (authentication template) / **Firebase Phone Auth** | Meta: server-driven, same path as login 2FA. Firebase: free at trial scale, no Indian DLT registration, but client-driven and needs a project + service account. |
|  | Login 2FA | **New-device/new-IP challenge, 30-day trusted device** | `TrustedDevice` cookie (hashed) skips the OTP on recognized devices; a signed `otp_verified` cookie gates `next-auth`'s Credentials `authorize()`. Always server-driven (OpenWA/Meta), regardless of the registration channel — the browser never sees the full stored number. |
|  | Profile photo | **`sharp`** | Real image decode (not a trusted `Content-Type` header), resize, and EXIF stripped on every upload. |
| **Runtime Configuration** | Settings storage | **`AppSetting`, AES-256-GCM encrypted** | Every external-service credential (Resend, OpenWA, Meta, Dinstar, Firebase, CRM webhook secret) admin-configurable at `/admin/settings`, takes effect immediately, no restart. Telephony settings (AMI/Coturn/domain) deliberately excluded — see that model's schema comment. |
|  | First-run setup | **`/setup` wizard** | Creates the first ADMIN account in the browser; reachable only until one exists. Replaces requiring shell access to the container. |

---

## 5. Forkable Repositories & Reference Codebases

Use these open-source repositories to accelerate feature implementation:

1. **Asterisk Docker Core:**
* [tiredofit/docker-asterisk](https://github.com/tiredofit/docker-asterisk) — Clean, production-ready Asterisk Docker build with PJSIP and SRTP support.


2. **WebRTC to SIP Implementation:**
* [onsip/SIP.js](https://github.com/onsip/SIP.js) — The foundational WebRTC library.
* [havfo/WEBRTC-to-SIP](https://github.com/havfo/WEBRTC-to-SIP) — Reference Asterisk configuration for browser WebSockets.


3. **Turnkey Telephony Alternative:**
* [wazo-platform/wazo-platform](https://github.com/wazo-platform/wazo-platform) — Programmable, API-first PBX built on Asterisk.


4. **UI Components & Foundations:**
* [shadcn-ui/ui](https://github.com/shadcn-ui/ui) — Accessible UI components.



---

## 6. Production Deployment & Configuration Files

### 6.1 `docker-compose.yml`

Create this file in `/opt/algo-pbx/docker-compose.yml` on your Ubuntu VM:

```yaml
version: '3.8'

services:
  # 1. PostgreSQL Database
  postgres:
    image: postgres:16-alpine
    container_name: algo-postgres
    restart: always
    environment:
      POSTGRES_USER: algopbx
      POSTGRES_PASSWORD: AlgoSecurePassword2026!
      POSTGRES_DB: algopbx_db
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    networks:
      - algo-net

  # 2. Coturn STUN/TURN Server
  coturn:
    image: coturn/coturn:latest
    container_name: algo-coturn
    restart: always
    network_mode: host
    command:
      - "-n"
      - "--log-file=stdout"
      - "--min-port=10000"
      - "--max-port=10100"
      - "--realm=algopbx.local"
      - "--use-auth-secret"
      - "--static-auth-secret=AlgoSecretAuthKey2026"

  # 3. Asterisk 20 PBX (Host Network Mode for direct RTP handling)
  asterisk:
    image: tiredofit/asterisk:20-latest
    container_name: algo-asterisk
    restart: always
    network_mode: host
    volumes:
      - ./pbx_configs/pjsip.conf:/etc/asterisk/pjsip.conf:ro
      - ./pbx_configs/rtp.conf:/etc/asterisk/rtp.conf:ro
      - ./pbx_configs/extensions.conf:/etc/asterisk/extensions.conf:ro
      - ./recordings:/var/spool/asterisk/monitor
    depends_on:
      - postgres

  # 4. Algo PBX Next.js Web App
  web:
    build:
      context: ./algo-pbx-frontend
      dockerfile: Dockerfile
    container_name: algo-web
    restart: always
    environment:
      DATABASE_URL: "postgresql://algopbx:AlgoSecurePassword2026!@postgres:5432/algopbx_db"
      NEXT_PUBLIC_SIP_WS_SERVER: "wss://YOUR_VM_PUBLIC_DOMAIN:8089/ws"
      NEXT_PUBLIC_TURN_SERVER: "turn:YOUR_VM_PUBLIC_DOMAIN:3478"
    ports:
      - "3000:3000"
    networks:
      - algo-net
    depends_on:
      - postgres

volumes:
  postgres_data:

networks:
  algo-net:
    driver: bridge

```

---

### 6.2 Asterisk Telephony Configurations

#### `/opt/algo-pbx/pbx_configs/pjsip.conf`

```ini
; =========================================
; TRANSPORT CONFIGURATIONS
; =========================================

; 1. UDP Transport for Dinstar Gateway & IP Phones
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060

; 2. Secure WebSocket Transport for WebRTC Agents
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0:8089

; =========================================
; DINSTAR 4-PORT GSM GATEWAY TRUNK (UAE)
; =========================================
[dinstar-trunk]
type=endpoint
transport=transport-udp
context=from-dinstar
disallow=all
allow=alaw,ulaw,g729
aors=dinstar-aor
direct_media=no

[dinstar-aor]
type=aor
contact=sip:192.168.1.50:5060 ; Tailscale local IP of Dinstar

[dinstar-identify]
type=identify
endpoint=dinstar-trunk
match=192.168.1.50

; =========================================
; WEBRTC AGENT TEMPLATE (Extension 1001)
; =========================================
[1001]
type=endpoint
transport=transport-wss
context=from-agent
disallow=all
allow=opus,ulaw,alaw
webrtc=yes
use_avpf=yes
media_encryption=dtls
dtls_verify=fingerprint
dtls_cert_file=/etc/asterisk/keys/asterisk.crt
dtls_private_key_file=/etc/asterisk/keys/asterisk.key
dtls_setup=actpass
ice_support=yes
media_use_received_transport=yes
auth=1001-auth
aors=1001-aor

[1001-auth]
type=auth
auth_type=userpass
username=1001
password=AgentSecurePass1001!

[1001-aor]
type=aor
max_contacts=2
remove_existing=yes

; =========================================
; GRANDSTREAM IP PHONE TEMPLATE (Extension 2001)
; =========================================
[2001]
type=endpoint
transport=transport-udp
context=from-internal
disallow=all
allow=alaw,ulaw
auth=2001-auth
aors=2001-aor

[2001-auth]
type=auth
auth_type=userpass
username=2001
password=HardwarePass2001!

[2001-aor]
type=aor
max_contacts=1

```

#### `/opt/algo-pbx/pbx_configs/rtp.conf`

```ini
[general]
rtpstart=10000
rtpend=10100
stunaddr=YOUR_VM_PUBLIC_DOMAIN:3478
turnaddr=YOUR_VM_PUBLIC_DOMAIN:3478
turnuser=algopbx.local
turnpwd=AlgoSecretAuthKey2026

```

#### `/opt/algo-pbx/pbx_configs/extensions.conf`

```ini
[from-agent]
; Outbound dialing through Dinstar GSM SIMs
exten => _X.,1,NoOp(Outbound Call from Agent: ${EXTEN})
 same => n,Set(CALLERID(num)=AlgoCallCenter)
 same => n,Dial(PJSIP/${EXTEN}@dinstar-trunk,60,T)
 same => n,Hangup()

; Internal Extension Calling
exten => _1XXX,1,Dial(PJSIP/${EXTEN},30)
exten => _2XXX,1,Dial(PJSIP/${EXTEN},30)

[from-dinstar]
; Inbound Call from UAE GSM SIM - Route to Ring Group
exten => s,1,NoOp(Inbound Call Received from Dinstar Gateway)
 same => n,Answer()
 same => n,Queue(support_queue,t,,,300)
 same => n,Hangup()

```

---

### 6.3 Tailscale Dinstar Subnet Routing Guide

To link the physical Dinstar box in the UAE office to the cloud VM:

```bash
# -------------------------------------------------------------
# STEP 1: ON THE UAE LOCAL OFFICE PC (Connected to Dinstar LAN)
# -------------------------------------------------------------
# 1. Enable IPv4 packet forwarding on the host:
echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf

# 2. Authenticate and advertise the local subnet (e.g. 192.168.1.0/24):
sudo tailscale up --advertise-routes=192.168.1.0/24

# 3. Open Tailscale Admin Console (login.tailscale.com) -> Machines -> Edit Route Settings -> APPROVE 192.168.1.0/24.

# -------------------------------------------------------------
# STEP 2: ON THE CLOUD UBUNTU SERVER (Algo PBX Host)
# -------------------------------------------------------------
# 1. Accept advertised routes:
sudo tailscale up --accept-routes

# 2. Test connection directly to the Dinstar Gateway:
ping 192.168.1.50
curl -I http://192.168.1.50

```

---

### 6.4 Next.js WebRTC Context (`SIPContext.tsx`)

Place this file in `/algo-pbx-frontend/src/contexts/SIPContext.tsx`:

```tsx
"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { UserAgent, Web, Invoker } from "sip.js";

interface SIPContextType {
  isConnected: boolean;
  callState: "idle" | "calling" | "ringing" | "active";
  makeCall: (destination: string) => void;
  answerCall: () => void;
  hangupCall: () => void;
  toggleMute: () => void;
  isMuted: boolean;
}

const SIPContext = createContext<SIPContextType | null>(null);

export const SIPProvider = ({ children }: { children: React.ReactNode }) => {
  const [userAgent, setUserAgent] = useState<UserAgent | null>(null);
  const [session, setSession] = useState<any>(null);
  const [callState, setCallState] = useState<"idle" | "calling" | "ringing" | "active">("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // WebRTC SIP.js UserAgent Configuration
    const uri = UserAgent.makeURI("sip:1001@YOUR_VM_PUBLIC_DOMAIN");
    if (!uri) return;

    const ua = new UserAgent({
      uri,
      transportOptions: {
        server: process.env.NEXT_PUBLIC_SIP_WS_SERVER || "wss://YOUR_VM_PUBLIC_DOMAIN:8089/ws",
      },
      authorizationUsername: "1001",
      authorizationPassword: "AgentSecurePass1001!",
      delegate: {
        onInvite: (incomingSession) => {
          setSession(incomingSession);
          setCallState("ringing");
          setupSessionHandlers(incomingSession);
        },
      },
    });

    ua.start()
      .then(() => {
        setIsConnected(true);
        setUserAgent(ua);
      })
      .catch((err) => console.error("SIP Connection Error:", err));

    return () => {
      ua.stop();
    };
  }, []);

  const setupSessionHandlers = (currentSession: any) => {
    currentSession.stateChange.addListener((newState: string) => {
      if (newState === "Established") {
        setCallState("active");
        // Attach Remote Media Stream to hidden Audio DOM element
        const remoteStream = new MediaStream();
        currentSession.sessionDescriptionHandler.peerConnection
          .getReceivers()
          .forEach((receiver: any) => {
            if (receiver.track) remoteStream.addTrack(receiver.track);
          });
        const audioElement = document.getElementById("remote-audio") as HTMLAudioElement;
        if (audioElement) {
          audioElement.srcObject = remoteStream;
          audioElement.play();
        }
      }
      if (newState === "Terminated") {
        setCallState("idle");
        setSession(null);
      }
    });
  };

  const makeCall = (destination: string) => {
    if (!userAgent) return;
    const target = UserAgent.makeURI(`sip:${destination}@YOUR_VM_PUBLIC_DOMAIN`);
    if (!target) return;

    const inviter = new Web.SimpleUser(userAgent as any, {
      media: { constraints: { audio: true, video: false } },
    });

    setCallState("calling");
    inviter.call(destination);
  };

  const answerCall = () => {
    if (session && callState === "ringing") {
      session.accept();
    }
  };

  const hangupCall = () => {
    if (session) {
      session.bye();
    }
    setCallState("idle");
  };

  const toggleMute = () => {
    if (!session) return;
    const pc = session.sessionDescriptionHandler.peerConnection;
    pc.getSenders().forEach((sender: any) => {
      if (sender.track) {
        sender.track.enabled = isMuted;
      }
    });
    setIsMuted(!isMuted);
  };

  return (
    <SIPContext.Provider value={{ answerCall, callState, hangupCall, isConnected, isMuted, makeCall, toggleMute }}>
      {children}
      <audio id="remote-audio" autoPlay />
    </SIPContext.Provider>
  );
};

export const useSIP = () => {
  const context = useContext(SIPContext);
  if (!context) throw new Error("useSIP must be used within a SIPProvider");
  return context;
};

```
