import * as React from "react";

const MIME_OPTIONS = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

function chooseMime(): string {
  if (typeof MediaRecorder.isTypeSupported !== "function") return "";
  return MIME_OPTIONS.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export function extensionForType(mime: string): string {
  const lowered = mime.toLowerCase();
  if (lowered.includes("mp4")) return "m4a";
  if (lowered.includes("ogg")) return "ogg";
  if (lowered.includes("wav")) return "wav";
  if (lowered.includes("mpeg") || lowered.includes("mp3")) return "mp3";
  return "webm";
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

/**
 * Microphone recording with the browser MediaRecorder. Stopping hands the
 * finished file to `onRecorded`; cancelling or unmounting discards it.
 */
export function useVoiceRecorder({
  maxSeconds,
  onRecorded,
}: {
  maxSeconds: number;
  onRecorded: (file: File, durationSeconds: number) => void;
}) {
  const [recording, setRecording] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const discardRef = React.useRef(false);
  const startedAtRef = React.useRef(0);
  const timerRef = React.useRef<number | null>(null);
  const mimeRef = React.useRef("audio/webm");
  const onRecordedRef = React.useRef(onRecorded);
  const maxSecondsRef = React.useRef(maxSeconds);
  React.useEffect(() => {
    onRecordedRef.current = onRecorded;
    maxSecondsRef.current = maxSeconds;
  });

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const finish = React.useCallback((discard: boolean) => {
    if (discard) discardRef.current = true;
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stopTracks();
    setRecording(false);
    if (discard) setElapsed(0);
  }, []);

  React.useEffect(() => () => finish(true), [finish]);

  const start = React.useCallback(async () => {
    setError(null);
    if (!window.isSecureContext) {
      setError("Microphone access requires HTTPS or localhost. Open Housetory at its secure address.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser cannot record audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = chooseMime();
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      mimeRef.current = recorder.mimeType || mime || "audio/webm";
      chunksRef.current = [];
      discardRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopTracks();
        if (discardRef.current) return;
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        if (blob.size === 0) {
          setError("No audio was captured. Check the microphone and try again.");
          return;
        }
        const file = new File([blob], `voice-note.${extensionForType(mimeRef.current)}`, {
          type: mimeRef.current.split(";")[0] || "audio/webm",
        });
        const duration = Math.max(
          1,
          Math.min(
            maxSecondsRef.current,
            Math.round((Date.now() - startedAtRef.current) / 1000),
          ),
        );
        onRecordedRef.current(file, duration);
      };
      recorder.start(250);
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
        setElapsed(seconds);
        if (seconds >= maxSecondsRef.current) finish(false);
      }, 250);
    } catch (caught) {
      stopTracks();
      const name = caught instanceof DOMException ? caught.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission was denied. Allow microphone access in the browser."
          : name === "NotFoundError"
            ? "No microphone was found."
            : "The microphone could not be opened. Check browser permissions and try again.",
      );
    }
  }, [finish]);

  const stop = React.useCallback(() => finish(false), [finish]);
  const cancel = React.useCallback(() => finish(true), [finish]);

  return { recording, elapsed, error, start, stop, cancel };
}
