// The canonical recorder also powers the full Voice page. Reusing it keeps
// microphone permissions, MIME selection, duration limits and cleanup identical.
export { Recorder as VoiceRecorder } from "@/pages/voice-page";
