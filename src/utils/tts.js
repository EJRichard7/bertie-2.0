export function isSpeakingSupported() {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window
  );
}

let currentUtterance = null;

/**
 * speakText(text, onEnd?)
 * - text: string to speak
 * - onEnd: optional callback when speech finishes
 */
export function speakText(text, onEnd) {
  if (!isSpeakingSupported()) return;

  stopSpeaking();

  const utterance = new SpeechSynthesisUtterance(text);
  currentUtterance = utterance;

  // 🔥 CRITICAL: allows auto-advance for document reading
  if (typeof onEnd === "function") {
    utterance.onend = () => {
      onEnd();
    };
  }

  utterance.onerror = (e) => {
    console.warn("TTS error:", e);
  };

  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (!isSpeakingSupported()) return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
}

export function pauseSpeaking() {
  if (!isSpeakingSupported()) return;
  window.speechSynthesis.pause();
}

export function resumeSpeaking() {
  if (!isSpeakingSupported()) return;
  window.speechSynthesis.resume();
}