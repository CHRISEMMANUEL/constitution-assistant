import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionResult = { transcript: string; isFinal: boolean };
interface SpeechRecognitionEvent extends Event {
  results: ArrayLike<ArrayLike<SpeechRecognitionResult>> & {
    length: number;
    [index: number]: ArrayLike<SpeechRecognitionResult>;
  };
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const getRecognition = (): SpeechRecognitionCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export interface UseVoiceOptions {
  lang?: string;
  onTranscript?: (transcript: string, isFinal: boolean) => void;
  onWordBoundary?: (wordIndex: number) => void;
}

export const useVoice = ({
  lang = 'en-US',
  onTranscript,
  onWordBoundary,
}: UseVoiceOptions = {}) => {
  const RecognitionCtor = getRecognition();
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onWordBoundaryRef = useRef(onWordBoundary);
  useEffect(() => {
    onWordBoundaryRef.current = onWordBoundary;
  });
  const fallbackTimer = useRef<number | null>(null);
  const clearFallback = () => {
    if (fallbackTimer.current != null) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
  };
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supportsRecognition = !!RecognitionCtor;
  const supportsSynthesis =
    typeof window !== 'undefined' && 'speechSynthesis' in window;

  const startListening = useCallback(() => {
    if (!RecognitionCtor) {
      setError("Voice input isn't supported in this browser.");
      return;
    }
    setError(null);
    const rec = new RecognitionCtor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = lang;

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let finalTranscript = '';
      let interimTranscript = '';
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i][0];
        if (e.results[i] && (e.results[i] as unknown as { isFinal: boolean }).isFinal) {
          finalTranscript += result.transcript;
        } else {
          interimTranscript += result.transcript;
        }
      }
      const text = finalTranscript || interimTranscript;
      if (text) onTranscript?.(text, !!finalTranscript);
    };
    rec.onerror = (e: Event) => {
      const err = (e as unknown as { error?: string }).error;
      setError(err ? `Voice input error: ${err}` : 'Voice input failed.');
      setListening(false);
    };
    rec.onend = () => setListening(false);

    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  }, [RecognitionCtor, lang, onTranscript]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speak = useCallback(
    (text: string, opts?: { rate?: number; pitch?: number }) => {
      if (!supportsSynthesis) {
        setError("Voice output isn't supported in this browser.");
        return;
      }
      window.speechSynthesis.cancel();
      clearFallback();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const rate = opts?.rate ?? 0.95;
      u.rate = rate;
      u.pitch = opts?.pitch ?? 1;

      const words = text.trim().split(/\s+/);
      const charsPerSec = 14 * rate;
      let wordIdx = -1;
      let boundaryFired = false;

      function advanceFallback() {
        wordIdx++;
        if (wordIdx >= words.length) return;
        onWordBoundaryRef.current?.(wordIdx);
        const wordLen = (words[wordIdx]?.length ?? 4) + 1;
        const delay = Math.max(80, (wordLen / charsPerSec) * 1000);
        fallbackTimer.current = window.setTimeout(advanceFallback, delay);
      }

      u.onstart = () => {
        setSpeaking(true);
        onWordBoundaryRef.current?.(-1);
        fallbackTimer.current = window.setTimeout(() => {
          if (!boundaryFired) advanceFallback();
        }, 1200);
      };
      u.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        boundaryFired = true;
        clearFallback();
        wordIdx++;
        onWordBoundaryRef.current?.(wordIdx);
      };
      u.onend = () => {
        clearFallback();
        setSpeaking(false);
        onWordBoundaryRef.current?.(-1);
      };
      u.onerror = () => {
        clearFallback();
        setSpeaking(false);
        onWordBoundaryRef.current?.(-1);
      };
      window.speechSynthesis.speak(u);
    },
    [supportsSynthesis, lang],
  );

  const stopSpeaking = useCallback(() => {
    if (!supportsSynthesis) return;
    clearFallback();
    window.speechSynthesis.cancel();
    setSpeaking(false);
    onWordBoundaryRef.current?.(-1);
  }, [supportsSynthesis]);

  return {
    listening,
    speaking,
    error,
    supportsRecognition,
    supportsSynthesis,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
  };
};
