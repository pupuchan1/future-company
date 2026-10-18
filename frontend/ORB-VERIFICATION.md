# Orb conversation state — issue #59

The official ElevenLabs sphere is unchanged. Both real microphone PCM and playable remote PCM drive deformation inside the
sphere, with bounded visual gain to make quiet syllables visible. Real remote
PCM also drives the gray output rings. Detection uses the original levels. A separate
conversation state distinguishes listening, user speech, waiting, assistant
speech and simultaneous speech. Waiting has a subdued dotted pulse, not fake
output energy. Reduced-motion mode disables that pulse.

The current Live data-channel allowlist contains session lifecycle and transcript
deltas, not speech-start/stop or output-playback-completed events. Therefore:

- A new accepted input transcript or active-session backend work marks a response
  pending. Duplicate transcript delivery does not reopen a completed response.
- Real PCM confirms speech; input holds for 350 ms and output for 650 ms across
  short gaps. These are UI smoothing windows, not proof of provider turn completion.
- Playback refusal, pause and zero volume cannot claim audible output. Muting
  affects input only. Handoff and stop reset intent; old-session events cannot
  restore the orb's state.
- Existing case and voice-session routing are preserved.

## Verification (2026-10-18)

- Frontend tests on the initial integration snapshot: 76 passed, including accepted-input → waiting → actual output,
  short gaps, simultaneous speech/interruption, mute, blocked playback, duplicate
  transcript, stale session and late callback after stop.
- TypeScript and production frontend build: passed (existing large Orb chunk
  warning remains).
- Built-in browser at `/voice-effects.html`: synthetic PCM input changes the
  sphere with the input label; synthetic PCM output shows the assistant label;
  waiting shows a distinct pending label and dotted pulse. Screenshots captured.
- Official `elevenlabs/Orb.tsx`: no changes in this branch.

## Outstanding acceptance

The real-AI browser harness was prepared but opening it timed out repeatedly in
browser control; Chrome was unavailable. No real-AI round trip or live human
utterance is claimed by this change. A human microphone check remains pending.

For local visual inspection run the frontend dev server and open
`/voice-effects.html`; select microphone, input, output, waiting or blocked. The
fixture is local-only and does not itself send audio to the AI. For an actual
conversation use the reception UI with the existing Worker/Live services running.
