'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSavedMicrophoneId, saveMicrophoneId } from '@/lib/visitor';

/**
 * Lets the user pick a microphone (e.g. a Bluetooth headset) before the call.
 * Browsers hide device names until microphone access is granted, so this offers
 * to ask for access first. The choice is saved and applied when the call starts.
 */
export function MicrophoneSelect({ disabled }: { disabled?: boolean }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [needsPermission, setNeedsPermission] = useState(false);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === 'audioinput'
    );
    setNeedsPermission(inputs.length > 0 && inputs.every((device) => !device.label));
    setDevices(inputs.filter((device) => device.label));
  }, []);

  useEffect(() => {
    setSelectedId(getSavedMicrophoneId());
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

  const handleChange = (deviceId: string) => {
    setSelectedId(deviceId);
    saveMicrophoneId(deviceId);
  };

  if (needsPermission) {
    return (
      <button
        type="button"
        onClick={requestAccess}
        disabled={disabled}
        className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
      >
        Choose microphone (e.g. Bluetooth headset)
      </button>
    );
  }

  if (devices.length === 0) {
    return null;
  }

  // A saved device that's no longer connected falls back to the system default.
  const value = devices.some((device) => device.deviceId === selectedId) ? selectedId : '';

  return (
    <label className="text-muted-foreground flex flex-col items-center gap-2 text-xs">
      Microphone
      <select
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        className="border-input bg-background text-foreground focus-visible:ring-ring h-9 max-w-72 rounded-full border px-3 text-xs outline-none focus-visible:ring-2"
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
