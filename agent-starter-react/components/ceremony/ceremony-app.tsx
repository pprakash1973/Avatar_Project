'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionState, TokenSource } from 'livekit-client';
import { useSession } from '@livekit/components-react';
import { WarningIcon } from '@phosphor-icons/react/dist/ssr';
import { AgentSessionProvider } from '@/components/agents-ui/agent-session-provider';
import { StartAudioButton } from '@/components/agents-ui/start-audio-button';
import { ConnectionDiagnosis } from '@/components/app/connection-diagnosis';
import { CeremonySetup } from '@/components/ceremony/ceremony-setup';
import { CeremonyStage } from '@/components/ceremony/ceremony-stage';
import { Toaster } from '@/components/ui/sonner';
import { toastAlert, useAgentErrors } from '@/hooks/useAgentErrors';
import { useCallDiagnostics } from '@/hooks/useCallDiagnostics';
import { DEFAULT_VOICE, VOICES, type VoiceCode } from '@/lib/agent-channels';
import {
  type Award,
  type CeremonySettings,
  DEFAULT_SETTINGS,
  loadServerSettings,
  loadSettings,
  saveSettings,
} from '@/lib/ceremony';
import type { PDFDocumentProxy } from '@/lib/pdf';
import {
  getSavedMicrophoneId,
  getSavedName,
  getSavedSpeakerId,
  getSavedVoice,
} from '@/lib/visitor';

const newRoomName = () => `voice_assistant_room_${crypto.randomUUID()}`;

// Ceremony mode: English, and Tina only reacts when called by name.
const CEREMONY_ATTRIBUTES = { mode: 'ceremony', language: 'en', wake: '1' };

function SessionHooks() {
  useAgentErrors();
  useCallDiagnostics();
  return null;
}

export function CeremonyApp({ agentName }: { agentName?: string }) {
  const tokenSource = useMemo(() => TokenSource.endpoint('/api/token'), []);
  const [roomName, setRoomName] = useState(newRoomName);
  const [voice, setVoice] = useState<VoiceCode>(DEFAULT_VOICE);
  const [settings, setSettings] = useState<CeremonySettings>(DEFAULT_SETTINGS);
  // Tina greets the host by this name when she joins.
  const [hostName, setHostName] = useState('');
  useEffect(() => {
    const saved = getSavedVoice();
    if (VOICES.some((v) => v.code === saved)) {
      setVoice(saved as VoiceCode);
    }
    const local = loadSettings();
    setSettings(local);
    setHostName(getSavedName());
    // Settings saved on another laptop (e.g. during a dry run) win if they are newer.
    void loadServerSettings().then((server) => {
      if (server && (server.saved_at ?? 0) > (local.saved_at ?? 0)) {
        setSettings(server);
        saveSettings(server);
      }
    });
  }, []);
  // `listen`: the languages the host may talk to Tina in, which picks her hearing model.
  const listen = settings.conversation_languages.join(',');
  const participantAttributes = useMemo(
    () => ({ ...CEREMONY_ATTRIBUTES, voice, listen }),
    [voice, listen]
  );
  const session = useSession(tokenSource, {
    agentConnectTimeoutMilliseconds: 60_000,
    ...(agentName ? { agentName } : {}),
    participantName: hostName.trim() || 'Host',
    participantAttributes,
    roomName,
  });

  const [deck, setDeck] = useState<PDFDocumentProxy | null>(null);
  const [awards, setAwards] = useState<Award[]>([]);
  const [onStage, setOnStage] = useState(false);

  // A fresh room after every disconnect, so a reconnect dispatches a new Tina.
  const wasActive = useRef(false);
  useEffect(() => {
    const isActive = session.connectionState !== ConnectionState.Disconnected;
    if (wasActive.current && !isActive) {
      setRoomName(newRoomName());
    }
    wasActive.current = isActive;
  }, [session.connectionState]);

  const start = async () => {
    const { room } = session;
    const microphoneId = getSavedMicrophoneId();
    if (microphoneId) {
      await room.switchActiveDevice('audioinput', microphoneId).catch(() => {});
    }
    const speakerId = getSavedSpeakerId();
    if (speakerId) {
      await room.switchActiveDevice('audiooutput', speakerId).catch(() => {});
    }
    setOnStage(true);
    try {
      await session.start();
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toastAlert({
          title: 'Microphone blocked',
          description: 'Allow microphone access so Tina can hear the host.',
        });
        return;
      }
      toastAlert({ title: 'Could not start Tina', description: 'Please try again.' });
    }
  };

  const end = async () => {
    setOnStage(false);
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }
    await session.end();
  };

  return (
    <AgentSessionProvider session={session}>
      <SessionHooks />
      {onStage && deck ? (
        <CeremonyStage
          deck={deck}
          awards={awards}
          settings={settings}
          onReconnect={start}
          onEnd={end}
        />
      ) : (
        <CeremonySetup
          deck={deck}
          onDeckChange={setDeck}
          awards={awards}
          onAwardsChange={setAwards}
          voice={voice}
          onVoiceChange={setVoice}
          hostName={hostName}
          onHostNameChange={setHostName}
          settings={settings}
          onSettingsChange={setSettings}
          onStart={start}
          isStarting={session.connectionState === ConnectionState.Connecting}
        />
      )}
      <StartAudioButton label="Start Audio" />
      <ConnectionDiagnosis />
      <Toaster
        icons={{ warning: <WarningIcon weight="bold" /> }}
        position="top-center"
        className="toaster group"
        style={
          {
            '--normal-bg': 'var(--popover)',
            '--normal-text': 'var(--popover-foreground)',
            '--normal-border': 'var(--border)',
          } as React.CSSProperties
        }
      />
    </AgentSessionProvider>
  );
}
