'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionState, TokenSource } from 'livekit-client';
import { useSession } from '@livekit/components-react';
import { WarningIcon } from '@phosphor-icons/react/dist/ssr';
import { AgentSessionProvider } from '@/components/agents-ui/agent-session-provider';
import { StartAudioButton } from '@/components/agents-ui/start-audio-button';
import { ConnectionDiagnosis } from '@/components/app/connection-diagnosis';
import { ViewController } from '@/components/app/view-controller';
import { Toaster } from '@/components/ui/sonner';
import { useAgentErrors } from '@/hooks/useAgentErrors';
import { useCallDiagnostics } from '@/hooks/useCallDiagnostics';
import { useDebugMode } from '@/hooks/useDebug';
import {
  DEFAULT_VOICE,
  LANGUAGES,
  type LanguageCode,
  STYLES,
  type StyleCode,
  VOICES,
  type VoiceCode,
} from '@/lib/agent-channels';
import {
  getSavedAdapt,
  getSavedLanguage,
  getSavedStyle,
  getSavedVoice,
  getVisitorId,
} from '@/lib/visitor';

const IN_DEVELOPMENT = process.env.NODE_ENV !== 'production';

const newRoomName = () => `voice_assistant_room_${crypto.randomUUID()}`;

function AppSetup() {
  useDebugMode({ enabled: IN_DEVELOPMENT });
  useAgentErrors();
  useCallDiagnostics();

  return null;
}

interface AppProps {
  tokenServerId?: string;
  tokenEndpoint: string;
  agentName?: string;
  isVideoInputSupported: boolean;
}

export function App({ tokenServerId, tokenEndpoint, agentName, isVideoInputSupported }: AppProps) {
  const tokenSource = useMemo(
    () =>
      tokenServerId
        ? TokenSource.developmentTokenServer(tokenServerId)
        : TokenSource.endpoint(tokenEndpoint),
    [tokenServerId, tokenEndpoint]
  );

  const [userName, setUserName] = useState('');
  const [language, setLanguage] = useState<LanguageCode>('en');
  const [visitorId, setVisitorId] = useState('');
  const [style, setStyle] = useState<StyleCode>('friendly');
  const [adaptToMood, setAdaptToMood] = useState(true);
  const [voice, setVoice] = useState<VoiceCode>(DEFAULT_VOICE);
  // A fresh room per call. Otherwise the cached token (valid 15 min) puts the next
  // call into the previous call's room, where no new agent is dispatched.
  const [roomName, setRoomName] = useState(newRoomName);

  // Browser storage is only available after hydration.
  useEffect(() => {
    setVisitorId(getVisitorId());
    const saved = getSavedLanguage();
    if (LANGUAGES.some((l) => l.code === saved)) {
      setLanguage(saved as LanguageCode);
    }
    const savedStyle = getSavedStyle();
    if (STYLES.some((s) => s.code === savedStyle)) {
      setStyle(savedStyle as StyleCode);
    }
    setAdaptToMood(getSavedAdapt());
    const savedVoice = getSavedVoice();
    if (VOICES.some((v) => v.code === savedVoice)) {
      setVoice(savedVoice as VoiceCode);
    }
  }, []);

  const participantAttributes = useMemo(
    () => ({ language, visitor_id: visitorId, style, adapt: adaptToMood ? '1' : '0', voice }),
    [language, visitorId, style, adaptToMood, voice]
  );
  const session = useSession(tokenSource, {
    // LiveKit Cloud stops an idle agent; waking it can take ~30 s (default is 20 s).
    agentConnectTimeoutMilliseconds: 60_000,
    ...(agentName ? { agentName } : {}),
    participantName: userName,
    participantAttributes,
    roomName,
  });

  // When a call ends (or fails to start), prepare a new room for the next one.
  const wasActive = useRef(false);
  useEffect(() => {
    const isActive = session.connectionState !== ConnectionState.Disconnected;
    if (wasActive.current && !isActive) {
      setRoomName(newRoomName());
    }
    wasActive.current = isActive;
  }, [session.connectionState]);

  return (
    <AgentSessionProvider session={session}>
      <AppSetup />
      <main className="grid h-svh grid-cols-1 place-content-center">
        <ViewController
          isVideoInputSupported={isVideoInputSupported}
          userName={userName}
          onUserNameChange={setUserName}
          language={language}
          onLanguageChange={setLanguage}
          conversationStyle={style}
          onConversationStyleChange={setStyle}
          adaptToMood={adaptToMood}
          onAdaptToMoodChange={setAdaptToMood}
          voice={voice}
          onVoiceChange={setVoice}
        />
      </main>
      <StartAudioButton label="Start Audio" />
      <ConnectionDiagnosis />
      <Toaster
        icons={{
          warning: <WarningIcon weight="bold" />,
        }}
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
