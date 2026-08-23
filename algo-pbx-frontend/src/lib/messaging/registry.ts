import type { MessageProvider, ProviderKind } from "./types";
import { OpenWaProvider } from "./openwa-provider";
import { MetaCloudProvider } from "./meta-cloud-provider";
import { DinstarSmsProvider } from "./dinstar-sms-provider";

// Which concrete adapter handles a given WaInstance is a config value
// (WaInstance.provider), resolved here — the one and only place a
// `provider === "X"` branch is allowed to exist. Every route, the ingest
// layer, and the agent chat UI's send path all call getProvider() instead
// of importing an adapter directly, so flipping an instance from OpenWA to
// Meta Cloud (the documented fallback path) is a data change, not a code
// change.
const providers: Record<ProviderKind, MessageProvider> = {
  OPENWA: new OpenWaProvider(),
  META_CLOUD: new MetaCloudProvider(),
  DINSTAR_SMS: new DinstarSmsProvider(),
};

export function getProvider(kind: ProviderKind): MessageProvider {
  const provider = providers[kind];
  if (!provider) throw new Error(`Unknown message provider kind: ${kind}`);
  return provider;
}
