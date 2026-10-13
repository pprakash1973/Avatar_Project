import { useEffect, useRef } from 'react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import { useAgent, useSessionContext } from '@livekit/components-react';

type DiagnosticEvent = [ms: number, type: string, detail?: string];

const MAX_EVENTS = 80;

/**
 * Records a timeline of each call attempt (connection states, who joined, which
 * tracks arrived, agent state, errors) and posts it to /api/diagnostics when the
 * attempt ends, so failures on other machines can be diagnosed from the server.
 */
export function useCallDiagnostics() {
  const { room } = useSessionContext();
  const agent = useAgent();
  const startedAt = useRef<number | null>(null);
  const events = useRef<DiagnosticEvent[]>([]);
  const sawAvatarVideo = useRef(false);

  useEffect(() => {
    const add = (type: string, detail?: string) => {
      if (startedAt.current === null || events.current.length >= MAX_EVENTS) {
        return;
      }
      events.current.push([Math.round(performance.now() - startedAt.current), type, detail]);
    };

    const flush = () => {
      if (startedAt.current === null) {
        return;
      }
      const body = JSON.stringify({
        room: room.name,
        started_at: new Date(Date.now() - (performance.now() - startedAt.current)).toISOString(),
        user_agent: navigator.userAgent,
        avatar_video: sawAvatarVideo.current,
        events: events.current,
      });
      startedAt.current = null;
      events.current = [];
      sawAvatarVideo.current = false;
      void fetch('/api/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    };

    const onConnectionState = (state: ConnectionState) => {
      if (state === ConnectionState.Connecting && startedAt.current === null) {
        startedAt.current = performance.now();
        events.current = [];
      }
      add('connection', state);
      if (state === ConnectionState.Disconnected) {
        flush();
      }
    };
    const onDisconnected = (reason?: unknown) => add('disconnected', String(reason ?? ''));
    const onParticipant = (p: { identity: string; kind: unknown }) =>
      add('participant_joined', `${p.identity} kind=${String(p.kind)}`);
    const onParticipantLeft = (p: { identity: string }) => add('participant_left', p.identity);
    const onTrack = (
      track: { kind: string },
      _pub: unknown,
      p: { identity: string; attributes: Record<string, string> }
    ) => {
      add('track_subscribed', `${track.kind} from ${p.identity}`);
      if (track.kind === 'video' && p.attributes['lk.publish_on_behalf']) {
        sawAvatarVideo.current = true;
      }
    };
    const onMediaError = (e: Error) => add('media_error', `${e.name}: ${e.message}`);

    room.on(RoomEvent.ConnectionStateChanged, onConnectionState);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.ParticipantConnected, onParticipant);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantLeft);
    room.on(RoomEvent.TrackSubscribed, onTrack);
    room.on(RoomEvent.MediaDevicesError, onMediaError);
    const onSignalReconnecting = () => add('signal_reconnecting');
    const onReconnecting = () => add('reconnecting');
    const onReconnected = () => add('reconnected');
    room.on(RoomEvent.SignalReconnecting, onSignalReconnecting);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConnectionState);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.ParticipantConnected, onParticipant);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantLeft);
      room.off(RoomEvent.TrackSubscribed, onTrack);
      room.off(RoomEvent.MediaDevicesError, onMediaError);
      room.off(RoomEvent.SignalReconnecting, onSignalReconnecting);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [room]);

  // Agent lifecycle (connecting, listening, failed + reasons) goes in the same timeline.
  useEffect(() => {
    if (startedAt.current === null) {
      return;
    }
    const detail = agent.failureReasons?.length
      ? `${agent.state}: ${agent.failureReasons.join('; ')}`
      : agent.state;
    events.current.push([Math.round(performance.now() - startedAt.current), 'agent', detail]);
  }, [agent.state, agent.failureReasons]);
}
