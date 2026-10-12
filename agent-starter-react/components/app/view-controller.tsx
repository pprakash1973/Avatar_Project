'use client';

import { useTheme } from 'next-themes';
import { ConnectionState } from 'livekit-client';
import { AnimatePresence, motion } from 'motion/react';
import { useAgent, useSessionContext, useVoiceAssistant } from '@livekit/components-react';
import { AgentSessionView_01 } from '@/components/agents-ui/blocks/agent-session-view-01';
import { WelcomeView } from '@/components/app/welcome-view';

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
}

export function ViewController({
  isVideoInputSupported,
  userName,
  onUserNameChange,
}: ViewControllerProps) {
  const { isConnected, connectionState, start } = useSessionContext();
  const agent = useAgent();
  const { videoTrack: avatarVideoTrack } = useVoiceAssistant();
  const { resolvedTheme } = useTheme();

  // Keep the welcome screen (with its spinner) up until the avatar's video arrives.
  const isAvatarReady = isConnected && avatarVideoTrack !== undefined;
  const isStarting = connectionState !== ConnectionState.Disconnected && !isAvatarReady;

  return (
    <AnimatePresence mode="wait">
      {/* Welcome view */}
      {!isAvatarReady && (
        <MotionWelcomeView
          key="welcome"
          {...VIEW_MOTION_PROPS}
          startButtonText="Start call"
          onStartCall={start}
          userName={userName}
          onUserNameChange={onUserNameChange}
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
  );
}
