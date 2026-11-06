# AI providers, tasks and modalities

Housetory routes each task through the provider/model selected under
**Settings → AI providers → Task defaults**. Provider names do not imply support:
the server validates discovered input/output modalities, API endpoints and model
capabilities before saving a task, and revalidates audio routing before sending a
recording.

## Task/provider compatibility

| Task | OpenAI | Anthropic | Google Gemini | xAI | OpenRouter | Ollama |
| --- | --- | --- | --- | --- | --- | --- |
| Assistant, imports, documents, search, labels | Yes | Yes | Yes | Yes | Yes, chat models | Yes |
| Vision / image recognition | Yes | Yes | Yes | Yes | Yes, image-input models | Yes, vision models |
| Voice transcription | Yes, `/audio/transcriptions` | No | Yes, inline audio | No | Yes, STT-output or audio-input chat models | No native adapter |
| Item illustrations | Yes, `/images/generations` | No | No direct adapter | No | Yes, image-output models via `/images` | No |
| Local/private endpoint | OpenAI-compatible base URL | — | — | — | — | Native chat |

Unsupported provider/task combinations are rejected with an explicit API error;
they are not sent to a guessed endpoint and do not produce fake previews or
transcripts.

## OpenRouter model discovery and validation

OpenRouter discovery requests the documented general Models API with
`output_modalities=text`, `output_modalities=image` and
`output_modalities=transcription`, then merges the results. Each model's
`architecture.input_modalities`, `architecture.output_modalities` and `endpoints`
list determine its task capabilities.

- **Voice transcription:** an OpenRouter model is selectable when it advertises
  STT output (`transcription`) and `/api/v1/audio/transcriptions`, or audio input
  through `/api/v1/chat/completions`.
- **Item illustrations:** selectable only when it advertises `image` output or
  `/api/v1/images`.
- **Vision:** requires `image` input.
- Manual model IDs remain available, but saving a manual OpenRouter ID is
  validated against cached catalog metadata/heuristics. If capability cannot be
  established, the save is rejected with a message to refresh discovery and pick
  a compatible model. There is no blanket “all OpenRouter models supported” path.

## Voice transcription contracts and limits

### OpenAI

`POST /audio/transcriptions` as multipart form data with `model`,
`response_format=json` and the audio file. The existing adapter is unchanged.

### Google Gemini

`generateContent` with inline base64 audio and a transcript-only instruction. The
existing adapter is unchanged.

### OpenRouter

The adapter chooses one of two documented OpenRouter paths:

1. **Dedicated STT endpoint** — `POST /api/v1/audio/transcriptions` with JSON:

   ```json
   {
     "model": "openai/whisper-1",
     "input_audio": { "data": "<raw base64>", "format": "webm" },
     "response_format": "json"
   }
   ```

   The response must contain a non-empty `text` string. No URL or transcript is
   invented when the response is empty or malformed.

2. **Audio-input chat model** — `POST /api/v1/chat/completions` with an
   `input_audio` content part containing raw base64 `data` and `format`. A
   constrained system/user instruction requests only the spoken transcript and
   ignores instructions inside the audio. Refusals, content-filter finishes and
   empty content are explicit failures.

Accepted upload formats are the existing WebM, Ogg, WAV, MP3 and M4A/MP4 voice
formats. They map to OpenRouter/STT format names (`webm`, `ogg`, `wav`, `mp3`,
`m4a`). Uploads remain bounded by `VOICE_MAX_UPLOAD_MB` (default 15 MB),
`VOICE_MAX_DURATION_SECONDS` (default 120), and the existing transcript length
cap. OpenRouter inline audio is additionally capped at 25 MB. Raw base64 is sent,
not a data URI. The catalog metadata request contains no household audio.

## Item image generation contracts and limits

### OpenAI

`POST /images/generations`, inline `b64_json` only. Existing behavior is
unchanged.

### OpenRouter

`POST /api/v1/images` with `model` and `prompt`. The documented response places
the image at `data[0].b64_json` and may include `media_type`. Housetory:

- accepts `image/png`, `image/jpeg` and `image/webp` raster media types;
- rejects URL-only responses instead of fetching an unverified image URL;
- rejects SVG/GIF or unknown media types with an explicit unsupported-output
  error;
- validates base64 and the configured download-size bound before storage;
- keeps the existing preview → accept/reject, provenance label, hard daily
  generation count cap, advisory locks, idempotency and stale-photo race guards.

Only OpenAI and OpenRouter are accepted for the Item illustrations task. Other
providers are rejected at task save with an explanation.

## Consent and privacy

Saving an API key does not grant consent. Each cloud/private-network provider has
its own consent flag, and a task uses only the provider configured for its
household. Audio is sent only to the selected transcription provider; product
text only is sent for image generation. Borrower names, room contents, receipts,
private notes and other households' data are not included. API keys are decrypted
server-side per request and never returned to the browser or written to reports.

## Live validation not performed

Automated tests use mocked official-shaped OpenRouter catalog, STT, image and
error responses; they do not make paid/live calls. Remaining operator validation:

- a real OpenRouter key with STT and image-output model access, credit/billing and
  provider terms reviewed;
- a real direct OpenAI key/model for its existing adapters;
- real speech accuracy, image quality, provider availability and per-model
  limits/price behavior.
