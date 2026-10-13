'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getSavedMicrophoneId,
  getSavedSpeakerId,
  saveMicrophoneId,
  saveSpeakerId,
} from '@/lib/visitor';

// Browsers that can route audio to a chosen output device (Chrome, Edge).
const canChooseSpeaker = () =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

const selectClassName =
  'border-input bg-background text-foreground focus-visible:ring-ring h-9 max-w-72 rounded-full border px-3 text-xs outline-none focus-visible:ring-2';

interface DeviceSelectProps {
  label: string;
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (deviceId: string) => void;
  disabled?: boolean;
}

function DeviceSelect({ label, devices, value, onChange, disabled }: DeviceSelectProps) {
  // A saved device that's no longer connected falls back to the system default.
  const current = devices.some((device) => device.deviceId === value) ? value : '';
  return (
    <label className="text-muted-foreground flex flex-col items-center gap-2 text-xs">
      {label}
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={selectClassName}
      >
        <option value="">System default</option>
        {devices
          .filter((device) => device.deviceId !== 'default')
          .map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
      </select>
    </label>
  );
}

type SinkableAudio = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };

/** Plays a short two-note chime on the chosen output device. */
async function playTestSound(speakerId: string) {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const gain = context.createGain();
  gain.connect(destination);
  [523.25, 783.99].forEach((frequency, i) => {
    const start = context.currentTime + i * 0.35;
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.3, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
    oscillator.start(start);
    oscillator.stop(start + 0.32);
  });
  const audio: SinkableAudio = new Audio();
  audio.srcObject = destination.stream;
  if (speakerId && audio.setSinkId) {
    await audio.setSinkId(speakerId);
  }
  await audio.play();
  setTimeout(() => {
    audio.pause();
    void context.close();
  }, 1000);
}

/** Live input level (0..1) of the chosen microphone while `active` is true. */
function useMicrophoneLevel(active: boolean, microphoneId: string, onError: () => void) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    let stopped = false;
    let frame = 0;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
          setLevel(Math.min(1, rms * 6));
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        onError();
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
  }, [active, microphoneId, onError]);
  return level;
}

const testButtonClassName =
  'border-input hover:bg-accent rounded-full border px-3 py-1 text-xs font-medium disabled:opacity-50';

/**
 * Lets the user pick a microphone and speaker (e.g. a Bluetooth headset) before
 * the call. Browsers hide device names until microphone access is granted, so
 * this offers to ask for access first. Choices are saved and applied when the
 * call starts.
 *
 * Bluetooth headsets on Windows switch to their "Hands-Free" profile while the
 * mic is in use, which silences their stereo "Headphones" output. Picking the
 * headset mic therefore also picks the matching output of the same device.
 */
export function MicrophoneSelect({ disabled }: { disabled?: boolean }) {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [microphoneId, setMicrophoneId] = useState('');
  const [speakerId, setSpeakerId] = useState('');
  const [needsPermission, setNeedsPermission] = useState(false);
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [testError, setTestError] = useState('');
  const handleMicError = useCallback(() => {
    setIsTestingMic(false);
    setTestError('Could not open that microphone. Check it is connected and allowed.');
  }, []);
  const micLevel = useMicrophoneLevel(isTestingMic && !disabled, microphoneId, handleMicError);

  const handleSpeakerTest = async () => {
    setTestError('');
    try {
      await playTestSound(speakerId);
    } catch {
      setTestError('Could not play on that speaker. Try another one or System default.');
    }
  };

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === 'audioinput');
    setNeedsPermission(audioInputs.length > 0 && audioInputs.every((device) => !device.label));
    setInputs(audioInputs.filter((device) => device.label));
    setOutputs(
      canChooseSpeaker()
        ? devices.filter((device) => device.kind === 'audiooutput' && device.label)
        : []
    );
  }, []);

  useEffect(() => {
    setMicrophoneId(getSavedMicrophoneId());
    setSpeakerId(getSavedSpeakerId());
    void refresh();
    // Pick up a headset that connects while the page is open.
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [refresh]);

  const requestAccess = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // Denied: the call will show its own "Microphone blocked" message.
    }
    await refresh();
  };

  const handleSpeakerChange = (deviceId: string) => {
    setSpeakerId(deviceId);
    saveSpeakerId(deviceId);
  };

  const handleMicrophoneChange = (deviceId: string) => {
    setMicrophoneId(deviceId);
    saveMicrophoneId(deviceId);
    // Match the output to the same physical device (same groupId), if any.
    const microphone = inputs.find((device) => device.deviceId === deviceId);
    const matchingOutput = microphone
      ? outputs.find(
          (device) => device.groupId === microphone.groupId && device.deviceId !== 'default'
        )
      : undefined;
    if (matchingOutput) {
      handleSpeakerChange(matchingOutput.deviceId);
    }
  };

  if (needsPermission) {
    return (
      <button
        type="button"
        onClick={requestAccess}
        disabled={disabled}
        className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
      >
        Choose microphone and speaker (e.g. Bluetooth headset)
      </button>
    );
  }

  if (inputs.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <DeviceSelect
        label="Microphone"
        devices={inputs}
        value={microphoneId}
        onChange={handleMicrophoneChange}
        disabled={disabled}
      />
      {outputs.length > 0 && (
        <DeviceSelect
          label="Speaker"
          devices={outputs}
          value={speakerId}
          onChange={handleSpeakerChange}
          disabled={disabled}
        />
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => {
            setTestError('');
            setIsTestingMic((on) => !on);
          }}
          disabled={disabled}
          aria-pressed={isTestingMic}
          className={testButtonClassName}
        >
          {isTestingMic ? 'Stop mic test' : 'Test microphone'}
        </button>
        <button
          type="button"
          onClick={handleSpeakerTest}
          disabled={disabled}
          className={testButtonClassName}
        >
          Play test sound
        </button>
      </div>
      {isTestingMic && (
        <div className="flex w-56 flex-col items-center gap-1">
          <div
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(micLevel * 100)}
            className="bg-muted h-2 w-full overflow-hidden rounded-full"
          >
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-75"
              style={{ width: `${Math.round(micLevel * 100)}%` }}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Speak now — the bar should move. For a headset, play the test sound while this runs.
          </p>
        </div>
      )}
      {testError && (
        <p role="alert" className="text-destructive text-xs">
          {testError}
        </p>
      )}
    </div>
  );
}
