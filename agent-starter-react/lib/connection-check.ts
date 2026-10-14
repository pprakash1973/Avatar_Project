import { type CheckInfo, CheckStatus, ConnectionCheck } from 'livekit-client';

export { CheckStatus };
export type { CheckInfo };

export const CALL_FAILED_EVENT = 'avatar-call-failed';

export type CallFailedDetail = {
  room: string;
  started_at: string;
  user_agent: string;
  events: [number, string, string?][];
};

export type ConnectionCheckResult = {
  serverHost: string;
  checks: CheckInfo[];
};

/**
 * Runs LiveKit's own connectivity checks (the ones behind livekit.io/connection-test)
 * against this project. Uses a separate "connection_check_" room with no agent, so
 * it doesn't start an avatar.
 */
export async function runConnectionCheck(
  onUpdate: (checks: CheckInfo[]) => void
): Promise<ConnectionCheckResult> {
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_name: `connection_check_${crypto.randomUUID()}`,
      participant_name: 'connection-check',
    }),
  });
  if (!response.ok) {
    throw new Error(`token request failed: ${response.status} ${await response.text()}`);
  }
  const { serverUrl, participantToken } = await response.json();
  const check = new ConnectionCheck(serverUrl, participantToken);
  check.on('checkUpdate', () => onUpdate([...check.getResults()]));

  await check.checkWebsocket();
  await check.checkWebRTC();
  await check.checkTURN();
  await check.checkConnectionProtocol();

  return { serverHost: new URL(serverUrl).host, checks: check.getResults() };
}

/** Plain-language reading of the check results. */
export function diagnose(checks: CheckInfo[]): { blocked: boolean; summary: string } {
  // Match on descriptions: check names are class names, which minification mangles.
  const failed = (text: string) =>
    checks.some(
      (c) => c.description.toLowerCase().includes(text) && c.status === CheckStatus.FAILED
    );

  if (failed('websocket')) {
    return {
      blocked: true,
      summary:
        "Your browser can't reach the avatar service at all. A firewall, proxy or security software (such as Zscaler) is blocking the connection to LiveKit.",
    };
  }
  if (failed('webrtc') && failed('turn')) {
    return {
      blocked: true,
      summary:
        'Your browser reaches the avatar service, but real-time audio/video (WebRTC) is blocked, including the fallback over port 443. This is typical of corporate security software such as Zscaler, a VPN or a strict firewall.',
    };
  }
  if (failed('webrtc') || failed('turn') || failed('udp vs tcp')) {
    return {
      blocked: true,
      summary:
        'Some real-time audio/video connections are blocked on this network, so calls may fail or be unreliable.',
    };
  }
  return {
    blocked: false,
    summary:
      'Your connection to the avatar service works. The call failed for another reason (for example the avatar was busy or the assistant was waking up). Please try again.',
  };
}

export const statusLabel = (status: CheckStatus) =>
  ({
    [CheckStatus.IDLE]: 'Waiting',
    [CheckStatus.RUNNING]: 'Checking…',
    [CheckStatus.SKIPPED]: 'Skipped',
    [CheckStatus.SUCCESS]: 'Passed',
    [CheckStatus.FAILED]: 'Failed',
  })[status];
