// Pure decision logic for Phase G's ad-hoc 3-way conference: given a
// snapshot of live channels (from AMI CoreShowChannels, collected via
// src/lib/ami-client.ts's sendAndCollect), decide which channels need to be
// AMI-Redirected into the shared ConfBridge room so the agent's existing
// call doesn't just drop the moment their own leg is pulled out of the
// original 2-party bridge.
//
// ⚠️ Confidence: MEDIUM-LOW on `BridgeId` actually being present on
// CoreShowChannel events — same caveat wallboard/route.ts's Linkedid-based
// call counting carries. If absent, this degrades to redirecting only the
// agent's own channel, which will very likely strand the original other
// party rather than merging them into the new conference — flagged in
// LLM.md, not silently accepted as correct.

export interface ChannelInfo {
  channel: string;
  bridgeId?: string;
}

export function findChannelsToRedirect(channels: ChannelInfo[], agentExtension: string): string[] {
  const agentChannel = channels.find((c) => c.channel.startsWith(`PJSIP/${agentExtension}-`));
  if (!agentChannel) return [];

  if (!agentChannel.bridgeId) return [agentChannel.channel];

  const peers = channels.filter(
    (c) => c.bridgeId === agentChannel.bridgeId && c.channel !== agentChannel.channel
  );
  return [agentChannel.channel, ...peers.map((p) => p.channel)];
}
