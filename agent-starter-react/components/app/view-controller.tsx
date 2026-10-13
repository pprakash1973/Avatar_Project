'use client';

import { useTheme } from 'next-themes';
import { ConnectionState } from 'livekit-client';
import { AnimatePresence, motion } from 'motion/react';
import { useAgent, useSessionContext, useVoiceAssistant } from '@livekit/components-react';
import { AgentSessionView_01 } from '@/components/agents-ui/blocks/agent-session-view-01';
import { SessionPanel } from '@/components/app/session-panel';
import { WelcomeView } from '@/components/app/welcome-view';
import { useAgentChannels } from '@/hooks/useAgentChannels';
import { toastAlert } from '@/hooks/useAgentErrors';
import type { LanguageCode, StyleCode } from '@/lib/agent-channels';
import { getSavedMicrophoneId, saveAdapt, saveStyle } from '@/lib/visitor';

const MotionWelcomeView = motion.create(WelcomeView);
const MotionSessionView = motion.create(AgentSessionView_01);

const VIEW_MOTION_PROPS = {
  variants: {
    visible: {
      opacity: 1,
    },
    hidden: {
      opacity: 0,
    },
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
  transition: {
    duration: 0.5,
    ease: 'linear',
  },
};

interface ViewControllerProps {
  isVideoInputSupported: boolean;
  userName: string;
  onUserNameChange: (name: string) => void;
  language: LanguageCode;
  onLanguageChange: (language: LanguageCode) => void;
  conversationStyle: StyleCode;
  onConversationStyleChange: (style: StyleCode) => void;
  adaptToMood: boolean;
  onAdaptToMoodChange: (adapt: boolean) => void;
}

export function ViewController({
  isVideoInputSupported,
  userName,
  onUserNameChange,
  language,
  onLanguageChange,
  conversationStyle,
  onConversationStyleChange,
  adaptToMood,
  onAdaptToMoodChange,
}: ViewControllerProps) {
  const { room, isConnected, connectionState, start } = useSessionContext();
  const agent = useAgent();
  const { videoTrack: avatarVideoTrack } = useVoiceAssistant();
  const { resolvedTheme } = useTheme();

  // Keep the welcome screen (with its spinner) up until the avatar's video arrives.
  const isAvatarReady = isConnected && avatarVideoTrack !== undefined;
  const isStarting = connectionState !== ConnectionState.Disconnected && !isAvatarReady;
  const { cards, dismissCard } = useAgentChannels({
    // Keep the start screen in sync when the user changes style by voice.
    onStyleChange: (newStyle, adapt) => {
      saveStyle(newStyle);
      saveAdapt(adapt);
      onConversationStyleChange(newStyle);
      onAdaptToMoodChange(adapt);
    },
  });

  const handleStartCall = async () => {
    // Use the microphone picked on the start screen (e.g. a Bluetooth headset);
    // set before connecting so the call's mic track is created on that device.
    const microphoneId = getSavedMicrophoneId();
    if (microphoneId) {
      await room.switchActiveDevice('audioinput', microphoneId).catch(() => {});
    }
    try {
      await start();
    } catch (error) {
      // A blocked microphone rejects start() even though the call itself connects.
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toastAlert({
          title: 'Microphone blocked',
          description:
            'Allow microphone access in your browser to talk to the avatar. You can still type in the chat.',
        });
        return;
      }
      // The token endpoint answers 429 with a readable message when the rate limit is hit.
      const message = error instanceof Error ? error.message : '';
      const rateLimited = message.match(/received 429 \/ ([\s\S]+)$/);
      toastAlert({
        title: rateLimited ? 'Call limit reached' : 'Could not start the call',
        description: rateLimited ? rateLimited[1] : 'Please try again in a moment.',
      });
    }
  };

  return (
    <>
      <AnimatePresence mode="wait">
        {/* Welcome view */}
        {!isAvatarReady && (
          <MotionWelcomeView
            key="welcome"
            {...VIEW_MOTION_PROPS}
            startButtonText="Start call"
            onStartCall={handleStartCall}
            userName={userName}
            onUserNameChange={onUserNameChange}
            language={language}
            onLanguageChange={onLanguageChange}
            conversationStyle={conversationStyle}
            onConversationStyleChange={onConversationStyleChange}
            adaptToMood={adaptToMood}
            onAdaptToMoodChange={onAdaptToMoodChange}
            isStarting={isStarting}
          />
        )}
        {/* Session view */}
        {isAvatarReady && (
          <MotionSessionView
            key="session-view"
            {...VIEW_MOTION_PROPS}
            preConnectMessage={
              agent.isConnected ? 'Agent is listening, ask it a question' : 'Waiting for agent'
            }
            supportsChatInput={true}
            supportsVideoInput={isVideoInputSupported}
            supportsScreenShare={isVideoInputSupported}
            isPreConnectBufferEnabled={true}
            themeMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
            className="fixed inset-0"
          />
        )}
      </AnimatePresence>
      {isAvatarReady && <SessionPanel cards={cards} onDismiss={dismissCard} />}
    </>
  );
}
