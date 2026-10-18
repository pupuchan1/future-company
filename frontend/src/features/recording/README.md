# Local conversation records

`useLiveConnection` owns one `LocalConversationRecorder` across department handoffs. It exposes `recording` beside `snapshot` and `voice`; a page can render `ConversationRecord` without creating a second connection or microphone request.

- The existing Start action and microphone permission allow capture. The reception explains that the conversation is recorded locally for MP3 download.
- An AudioWorklet mixes the existing microphone and active remote audio. Muting suppresses microphone capture. A handoff suppresses both sources, and candidate audio is excluded until activation and playback succeed. The worklet output is silent so the microphone never echoes to speakers.
- The same-origin encoding Worker uses `@breezystack/lamejs@1.2.7` to encode mono 48 kHz, 128 kbps MP3. It retains compressed bytes, not the entire raw PCM recording. It makes no network request. The library source is at <https://github.com/gideonstele/lamejs>; its LGPL notice is served at `/licenses/lamejs.txt`.
- Stop flushes the final PCM block and encoder, closes AudioContext/worker resources and creates a local Blob URL. The MP3 is available for playback and explicit download. New recording/unmount revokes the previous URL. Neither audio nor transcripts are uploaded or stored in localStorage by this feature.
- Live retains ownership of microphone tracks. The recorder never calls `track.stop()` and never records a standby candidate. An unsupported or failed recorder shows a message while the voice connection can continue.
- Transcript history has no 200-turn truncation. The event-ID set lasts for the call to deduplicate SSE/data-channel copies. ID-less fragments only join the immediately preceding turn by the same speaker. Text and audio are separate records; transcripts are not evidence of received audio.

Tests: `conversation-recording.test.ts`, `conversation-capture.test.ts`, and recording cases in `live-handoff.test.ts`. Real MP3 files from synthetic PCM are decoded independently with ffprobe/ffmpeg. An actual browser AudioWorklet/microphone recording check is a separate acceptance step.
