'use client';

import { useEffect, useMemo, useState } from 'react';
import { TokenSource } from 'livekit-client';
import { useSession } from '@livekit/components-react';
import { WarningIcon } from '@phosphor-icons/react/dist/ssr';
import { AgentSessionProvider } from '@/components/agents-ui/agent-session-provider';
import { StartAudioButton } from '@/components/agents-ui/start-audio-button';
import { ViewController } from '@/components/app/view-controller';
import { Toaster } from '@/components/ui/sonner';
import { useAgentErrors } from '@/hooks/useAgentErrors';
import { useDebugMode } from '@/hooks/useDebug';
import { LANGUAGES, type LanguageCode } from '@/lib/agent-channels';
import { getSavedLanguage, getVisitorId } from '@/lib/visitor';

const IN_DEVELOPMENT = process.env.NODE_ENV !== 'production';

function AppSetup() {
  useDebugMode({ enabled: IN_DEVELOPMENT });
  useAgentErrors();

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

  // Browser storage is only available after hydration.
  useEffect(() => {
    setVisitorId(getVisitorId());
    const saved = getSavedLanguage();
    if (LANGUAGES.some((l) => l.code === saved)) {
      setLanguage(saved as LanguageCode);
    }
  }, []);

  const participantAttributes = useMemo(
    () => ({ language, visitor_id: visitorId }),
    [language, visitorId]
  );
  const session = useSession(tokenSource, {
    ...(agentName ? { agentName } : {}),
    participantName: userName,
    participantAttributes,
  });

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
        />
      </main>
      <StartAudioButton label="Start Audio" />
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
