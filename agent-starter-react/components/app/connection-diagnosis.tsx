'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircleIcon,
  CircleNotchIcon,
  MinusCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import {
  CALL_FAILED_EVENT,
  type CallFailedDetail,
  type CheckInfo,
  CheckStatus,
  type ConnectionCheckResult,
  diagnose,
  runConnectionCheck,
  statusLabel,
} from '@/lib/connection-check';

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === CheckStatus.SUCCESS) {
    return <CheckCircleIcon weight="fill" className="size-4 shrink-0 text-green-600" />;
  }
  if (status === CheckStatus.FAILED) {
    return <XCircleIcon weight="fill" className="text-destructive size-4 shrink-0" />;
  }
  if (status === CheckStatus.RUNNING) {
    return <CircleNotchIcon weight="bold" className="size-4 shrink-0 animate-spin" />;
  }
  return <MinusCircleIcon className="text-muted-foreground size-4 shrink-0" />;
}

function firewallRules(serverHost: string) {
  const subdomain = serverHost.replace(/\.livekit\.cloud$/, '');
  return [
    `${serverHost} (and *.livekit.cloud) — TCP 443, secure WebSocket (signaling)`,
    `${subdomain}.turn.livekit.cloud (and *.turn.livekit.cloud) — TCP 443, TURN over TLS`,
    '*.host.livekit.cloud — UDP 3478, TURN over UDP',
    'Any host — UDP 50000–60000, WebRTC media (recommended)',
    'Any host — TCP 7881, WebRTC over TCP (recommended)',
    'If TLS/SSL inspection is on (e.g. Zscaler), exclude these hosts — inspection commonly breaks WebRTC and TURN over TLS',
  ];
}

function reportText(
  detail: CallFailedDetail,
  result: ConnectionCheckResult | null,
  checks: CheckInfo[],
  summary: string
) {
  const lines = [
    'Voice avatar assistant — connection report',
    `Time: ${new Date().toISOString()}`,
    `Page: ${window.location.origin}`,
    `Browser: ${detail.user_agent}`,
    `LiveKit server: ${result?.serverHost ?? 'unknown'}`,
    '',
    `Result: ${summary}`,
    '',
    'Connectivity checks:',
    ...checks.map(
      (c) =>
        `- ${c.description}: ${statusLabel(c.status)}` +
        c.logs
          .filter((l) => l.level !== 'info')
          .map((l) => `\n    ${l.level}: ${l.message}`)
          .join('')
    ),
    '',
    'Please allow (LiveKit Cloud firewall requirements, docs.livekit.io/home/cloud/firewall):',
    ...(result ? firewallRules(result.serverHost).map((r) => `- ${r}`) : []),
    '',
    `Failed call attempt (room ${detail.room}, started ${detail.started_at}):`,
    ...detail.events.map(([ms, type, d]) => `  +${ms} ms ${type}${d ? ` ${d}` : ''}`),
  ];
  return lines.join('\n');
}

/**
 * Opens when a call attempt never shows the avatar. Runs LiveKit's connectivity
 * checks and explains, in plain words and with copyable details for an IT team,
 * whether the network (e.g. Zscaler, VPN, firewall) is blocking the connection.
 */
export function ConnectionDiagnosis() {
  const [detail, setDetail] = useState<CallFailedDetail | null>(null);
  const [checks, setChecks] = useState<CheckInfo[]>([]);
  const [result, setResult] = useState<ConnectionCheckResult | null>(null);
  const [error, setError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = useCallback(async () => {
    setIsRunning(true);
    setError('');
    setResult(null);
    setChecks([]);
    try {
      setResult(await runConnectionCheck(setChecks));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
    }
  }, []);

  useEffect(() => {
    const onFailed = (event: Event) => {
      setDetail((event as CustomEvent<CallFailedDetail>).detail);
      setCopied(false);
      void run();
    };
    window.addEventListener(CALL_FAILED_EVENT, onFailed);
    return () => window.removeEventListener(CALL_FAILED_EVENT, onFailed);
  }, [run]);

  if (!detail) {
    return null;
  }

  const finalChecks = result?.checks ?? checks;
  const verdict = error
    ? {
        blocked: true,
        summary: `The connection test itself could not start (${error}). The network may be blocking the avatar service.`,
      }
    : isRunning
      ? null
      : diagnose(finalChecks);

  const copy = async () => {
    const text = reportText(detail, result, finalChecks, verdict?.summary ?? 'Test running');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="connection-diagnosis-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="bg-background text-foreground max-h-[90svh] w-full max-w-lg overflow-y-auto rounded-xl border p-5 text-sm shadow-lg">
        <h2 id="connection-diagnosis-title" className="text-base font-semibold">
          The avatar couldn&apos;t connect
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          {isRunning
            ? 'Testing your connection to the avatar service…'
            : 'Connection test results for this device and network:'}
        </p>

        <ul className="mt-4 flex flex-col gap-2">
          {finalChecks.map((check) => (
            <li key={check.description} className="flex items-center gap-2">
              <StatusIcon status={check.status} />
              <span className="flex-1">{check.description}</span>
              <span className="text-muted-foreground text-xs">{statusLabel(check.status)}</span>
            </li>
          ))}
          {isRunning && finalChecks.length === 0 && (
            <li className="text-muted-foreground flex items-center gap-2">
              <CircleNotchIcon weight="bold" className="size-4 animate-spin" /> Starting test…
            </li>
          )}
        </ul>

        {verdict && (
          <div
            className={`mt-4 rounded-lg border p-3 ${verdict.blocked ? 'border-destructive/50 bg-destructive/5' : ''}`}
          >
            <p className="font-medium">
              {verdict.blocked ? 'Connection blocked' : 'Connection OK'}
            </p>
            <p className="mt-1">{verdict.summary}</p>
          </div>
        )}

        {verdict?.blocked && result && (
          <div className="mt-4">
            <p className="font-medium">Ask your IT team to allow:</p>
            <ul className="text-muted-foreground mt-1 list-disc space-y-1 pl-5 text-xs">
              {firewallRules(result.serverHost).map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-2 text-xs">
              Until then, try another network such as a phone hotspot.
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={copy} disabled={isRunning}>
            {copied ? 'Copied' : 'Copy details for IT'}
          </Button>
          <Button variant="outline" onClick={run} disabled={isRunning}>
            Run test again
          </Button>
          <Button onClick={() => setDetail(null)}>Close</Button>
        </div>
      </div>
    </div>
  );
}
