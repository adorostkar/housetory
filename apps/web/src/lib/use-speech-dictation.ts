import * as React from "react";

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeechDictation(onFinalText: (text: string) => void) {
  const supported = getCtor() !== null;
  const [listening, setListening] = React.useState(false);
  const recognitionRef = React.useRef<Recognition | null>(null);
  const callbackRef = React.useRef(onFinalText);
  callbackRef.current = onFinalText;

  const stop = React.useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = React.useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor || recognitionRef.current) return;
    const recognition = new Ctor();
    recognition.lang = document.documentElement.lang || navigator.language;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result?.isFinal) callbackRef.current(result[0].transcript.trim());
      }
    };
    const finish = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognition.onend = finish;
    recognition.onerror = finish;
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, []);

  const toggle = React.useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  React.useEffect(() => () => recognitionRef.current?.abort(), []);

  return { supported, listening, toggle, stop };
}
