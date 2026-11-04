# Voice-note inventory entry

Voice notes are another route through **Add items**. The flow is deliberately
review-first:

```
record or upload audio
  → transcribe
  → edit the transcript
  → AI proposes structured mentions
  → deterministic grouping, location matching and duplicate detection
  → edit names, quantities, destinations and duplicate decisions
  → explicitly confirm selected suggestions
```

Transcription and interpretation never create inventory by themselves. No room
or container is created until the confirmation request explicitly includes a
new-room/new-container choice.

## Supported providers

The transcript and the inventory interpretation are separate AI tasks:

| Stage | Task setting | Supported provider path |
| --- | --- | --- |
| Transcription | **Voice transcription** | OpenAI `/audio/transcriptions` (`whisper-1` or another compatible transcription model) or Google Gemini `generateContent` with inline audio |
| Inventory interpretation | **Smart imports** | Any configured chat model that supports structured JSON |

The selected vision or assistant model is never assumed to transcribe audio.
If the transcription task is unassigned, unsupported or unconsented, the page
shows a setup state and disables recording/upload. Existing manual entry,
imports, photos, search and labels continue to work without voice configuration.

A self-hosted OpenAI-compatible endpoint can be used for transcription by adding
an **OpenAI** provider with its own base URL, if it genuinely implements
`POST /audio/transcriptions`. Housetory does not bundle or download a speech
model, and local transcription is not claimed as universally available.

### Configuration steps

1. Open **Settings → AI providers** as the household owner.
2. Add OpenAI with base URL `https://api.openai.com/v1`, or Google Gemini with
   its normal API base URL.
3. Enter the API key. Keys remain encrypted server-side and are never returned
   to the browser.
4. Enable the provider's remote-processing consent if the endpoint is not on the
   Housetory host. Consent is required before any audio or transcript leaves the
   server.
5. Under **Task defaults → Voice transcription**, choose the provider and a
   transcription model. For OpenAI use `whisper-1`; for Gemini use a model that
   accepts audio input.
6. Under **Task defaults → Smart imports**, choose the chat model that should
   interpret the edited transcript.
7. Open **Add items → Record a voice note**.

No provider credentials are required for automated tests. The automated suite
uses mocked transcription and interpretation responses; no paid AI calls are
made.

## Audio formats and limits

Browser recording uses `MediaRecorder` when available. The app chooses a
supported MIME type in this order: WebM/Opus, WebM, MP4/M4A (Safari), Ogg/Opus.
Audio uploads accept WebM, Ogg, WAV, MP3 and M4A/MP4. Server-side validation
checks the file signature, not only the extension or client content type.

Defaults:

- Maximum upload size: **15 MB** (`VOICE_MAX_UPLOAD_MB`)
- Maximum duration: **120 seconds** (`VOICE_MAX_DURATION_SECONDS`)
- Maximum in-flight/retryable voice notes per household: **10**
  (`VOICE_MAX_ACTIVE_NOTES`)
- Maximum suggestions per interpretation: **50** (`VOICE_MAX_SUGGESTIONS`)
- Maximum transcript length: **12,000 characters** (`VOICE_MAX_TRANSCRIPT_CHARS`)

Microphone capture requires HTTPS or `localhost`. Browsers without a supported
recorder, or without microphone permission, show an explanation and keep the
upload alternative available. Empty or unintelligible audio produces a clear
failure; there is no keyword or fake transcription fallback.

## What the transcript produces

The interpretation model returns individual mentions with exact transcript
evidence, an optional explicit quantity and an optional location. Grouping and
counting happen on the server:

- Repeated mentions of the same item in the same room/container become one
  suggestion. `ethernet cable, ethernet cable, another ethernet cable` becomes
  **Ethernet cable × 3**.
- An explicit count such as `three ethernet cables` sets the quantity directly.
- A self-correction such as `three, actually four` replaces the earlier count
  instead of adding a fourth group.
- A recap or summary is marked as a summary and is not counted again.
- Meaningful variants stay separate: 1-metre and 5-metre Ethernet cables, red and
  blue versions, different brands/models/serials.
- The same item in different rooms or containers stays separate.
- No quantity is invented. A mention with no stated count contributes one
  occurrence unless it is a correction or summary.
- Source transcript spans are retained and shown as evidence for each item and
  location.

The AI must return the strict structured schema. Invalid JSON, unsupported
fields or missing evidence fail the interpretation without writing inventory.

## Locations, duplicates and moves

Spoken locations are matched against existing rooms and places first. The
matcher accepts natural variants including `box two`, `Box 2` and identifiers
such as `BOX-002`; matching is scoped to the household and, when known, the room.
Room-only items are valid.

- Ambiguous or unmatched locations are flagged and require an explicit existing
  choice or an explicit create action during review.
- New rooms and containers are created only from the review UI and are subject
  to the existing uniqueness, hierarchy and container-identifier rules. Reusing
  the same normalized name does not create duplicates.
- Likely existing items are shown as duplicate candidates. A strong candidate
  cannot be applied without choosing **create as new**, **add the quantity to an
  existing item**, or **already recorded — skip**. Existing quantities are never
  incremented silently.
- Move statements such as “move the drill from box two to box six” are detected
  and shown as unsupported/manual. They do not become new inventory in this
  version.

## Privacy and retention

- Audio is sent only to the configured **Voice transcription** provider. The
  editable transcript is sent only to the configured **Smart imports** provider
  after the user chooses Interpret.
- Both stages honor the provider's existing remote-processing consent. There is
  no silent cloud fallback.
- Audio is stored in the private imports volume and is not attached to inventory
  items. It is deleted after a successful transcript or on cancellation.
- If transcription fails, the audio is retained privately so the user can retry;
  cancelling or deleting the voice note removes it.
- Transcripts, suggestions and applied item links remain in the voice-note
  record for review/audit. They are household-scoped.
- Raw audio, transcripts and credentials are not written to application logs.
- Transcript content is treated as untrusted data. The model is instructed not
  to follow instructions found inside it, and the server only consumes the
  validated structured result; it cannot call tools or change permissions.

## Walkthrough

1. Open **Add items** and choose **Record a voice note**.
2. Optionally choose a default room/container for mentions that do not state a
   location.
3. Allow microphone access and record, or upload an audio file.
4. Wait for transcription. On failure, retry if the audio is still retained, or
   cancel and record again.
5. Edit the transcript. Correct names, counts and room words.
6. Choose **Interpret inventory**.
7. Review each suggestion: edit name/quantity, choose room/container or explicitly
   create one, resolve duplicates, and split a grouped suggestion when it contains
   distinct records.
8. Confirm selected suggestions. Successful entries are idempotent; retrying a
   partial confirmation never inserts the same suggestion twice.

## Verification scope

Automated checks use a disposable PostgreSQL database and mocked providers. They
cover repeated mentions, explicit counts, corrections, summaries, variants,
multiple locations, ambiguity, moves, duplicate resolution, add-quantity,
splitting, no-write-before-confirmation, idempotent confirmation, invalid AI
output, audio validation, cancellation/cleanup, viewer permissions and
cross-household isolation. The adapters are tested against captured-shaped
responses for the OpenAI multipart endpoint and Gemini inline-audio endpoint.

Not verified automatically in this environment:

- a real OpenAI or Gemini transcription request with paid credentials;
- a physical microphone/browser permission prompt;
- real speech accuracy or model quality;
- local/self-hosted speech-endpoint conformance.

Those require the operator's provider credentials and a real browser/microphone.
