import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionContext } from '@livekit/components-react';
import { toastAlert } from '@/hooks/useAgentErrors';
import {
  type AgentCard,
  type AgentStatus,
  type StyleCode,
  UI_CARD_TOPIC,
  UI_STATUS_TOPIC,
} from '@/lib/agent-channels';

const MAX_CARDS = 6;

export type CardWithId = AgentCard & { id: string };

/** Receives on-screen cards and status messages the agent sends during a call. */
interface AgentChannelOptions {
  onStyleChange?: (style: StyleCode, adaptToMood: boolean) => void;
}

export function useAgentChannels({ onStyleChange }: AgentChannelOptions = {}) {
  const { room, isConnected, end } = useSessionContext();
  const [cards, setCards] = useState<CardWithId[]>([]);
  const onStyleChangeRef = useRef(onStyleChange);
  onStyleChangeRef.current = onStyleChange;

  useEffect(() => {
    room.registerTextStreamHandler(UI_CARD_TOPIC, async (reader) => {
      try {
        const card = JSON.parse(await reader.readAll()) as AgentCard;
        setCards((prev) => [{ ...card, id: reader.info.id }, ...prev].slice(0, MAX_CARDS));
      } catch (error) {
        console.error('invalid card from agent', error);
      }
    });
    room.registerTextStreamHandler(UI_STATUS_TOPIC, async (reader) => {
      try {
        const status = JSON.parse(await reader.readAll()) as AgentStatus;
        if (status.type === 'style') {
          onStyleChangeRef.current?.(status.style, status.adapt);
        } else if (status.type === 'busy') {
          end();
          toastAlert({
            title: 'The avatar is busy or unavailable',
            description:
              'Someone else may be talking to the avatar, or its free minutes are used up. Please try again later.',
          });
        }
      } catch (error) {
        console.error('invalid status from agent', error);
      }
    });
    return () => {
      room.unregisterTextStreamHandler(UI_CARD_TOPIC);
      room.unregisterTextStreamHandler(UI_STATUS_TOPIC);
    };
  }, [room, end]);

  // Each call starts with a clean slate.
  useEffect(() => {
    if (!isConnected) {
      setCards([]);
    }
  }, [isConnected]);

  const dismissCard = useCallback(
    (id: string) => setCards((prev) => prev.filter((card) => card.id !== id)),
    []
  );

  return { cards, dismissCard };
}
