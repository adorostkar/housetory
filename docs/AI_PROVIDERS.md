# AI providers, tasks and modalities

Housetory routes each task through the provider/model selected under
**Settings → AI providers → Task defaults**. Provider names do not imply support:
the server validates discovered input/output modalities, API endpoints and model
capabilities before saving a task, and revalidates audio routing before sending a
recording.

## Task/provider compatibility

| Task | OpenAI | Anthropic | Google Gemini | xAI | OpenRouter | Ollama |
| --- | --- | --- | --- | --- | --- | --- |
| Assistant, imports, documents, search | Yes | Yes | Yes | Yes | Yes, chat models | Yes |
| Vision / image recognition | Yes | Yes | Yes | Yes | Yes, image-input models | Yes, vision models |
| Voice transcription | Yes, `/audio/transcriptions` | No | Yes, inline audio | No | Yes, STT-output or audio-input chat models | No native adapter |
| Local/private endpoint | OpenAI-compatible base URL | — | — | — | — | Native chat |

## Task-specific selection contract

The model picker and server use one capability contract:

| Task(s) | Actual minimum | Adapter providers |
| --- | --- | --- |
| Assistant, Smart imports, Document interpretation, Natural-language search | Text output | OpenAI, Anthropic, Gemini, xAI, OpenRouter, Ollama |
| Image recognition | Image input + text output | Same provider adapters, model metadata permitting |
| Voice transcription | STT output or audio input | OpenAI, Gemini, OpenRouter |

Native tool calling and native structured-output support are **not** blanket
requirements. Existing server-side JSON validation and safe text-parsing
fallbacks remain in force. Item illustrations and label/container AI headlines
were retired from task defaults and live testing.

Models are presented in four states:

- **Suggested** — provider metadata confirms the required capability. This is a
  heuristic ordering, not a quality benchmark.
- **Compatible** — the task adapter and model metadata support the task.
- **Unverified** — capability metadata is incomplete or the exact model ID is not
  in the catalog. Saving is allowed, but the UI warns and offers an explicit live
  test. Confirmed-incompatible IDs are still rejected.
- **Unavailable / adapter unavailable** — the implemented adapter cannot serve
  that task/provider. The message distinguishes a Housetory adapter gap from a
  provider being incapable.

A missing adapter is never presented as proof that a provider cannot do the task.
Selecting one key/provider remains valid; there is no silent alternate-provider or
key fallback.

## Explicit live task tests

Discovery only reads catalog metadata. A separate owner-only
`POST /ai/tasks/{task}/test` requires `confirm: true` and uses minimal synthetic
data (a short text/JSON prompt, a synthetic WAV tone or a small synthetic vision image depending on the task). The UI shows a confirmation warning
that the provider may incur usage/cost and that no inventory, borrower, document or
private note data is used. Results and bounded errors are stored for the status
screen. No test runs on typing, discovery, page load or model recommendation.

System status also offers **Test all AI tasks**. One confirmation explains the
count and names of enabled/configured tasks, external provider calls and possible
credits/cost. It then calls the same owner-only task-test endpoint sequentially for
each enabled/configured task using that task's saved provider and model; tasks that
share a model are still tested separately because their probes differ. Disabled and
unconfigured tasks are shown as skipped with a reason. Progress moves through
queued/running/passed/failed/unsupported/skipped, failures do not stop later tasks,
client timeouts are reported honestly, and duplicate runs are blocked while one is
in progress. The action never enables tasks, changes assignments, discovers models
or falls back to another provider. Individual Test buttons remain available.

## System status

Main **Settings** shows a compact, owner-only system-health summary. It counts
core readiness problems, failed worker jobs and failures in features that are
actually configured. Optional services that are not configured are listed
separately and do not count as outages. The summary links to the dedicated
**Settings → System status** page.

The detailed page shows the deployed release commit/build/channel/identity,
database/storage/worker readiness, job counts and recent failures with explicit
retry, per-task configured/compatible/live-tested state and last error/time, plus
configured/not-configured optional external services. **Refresh status** is passive:
it only rereads stored/runtime evidence and never calls a provider. **Test all AI
tasks** is a separate, explicitly confirmed live action. The screen never returns
API keys, job payloads, prompts, borrower notes or inventory details. A catalog
listing is not a successful inference test; only an explicit task test marks a task
live-tested.

The compact Settings summary and dedicated detailed page are captured in
[`01-settings-summary-light.png`](walkthrough/system-status-page/01-settings-summary-light.png)
and [`02-detailed-status-light.png`](walkthrough/system-status-page/02-detailed-status-light.png).

Walkthrough screenshots of the separate passive and live actions:
[`01-status-actions.png`](walkthrough/test-all-ai-tasks/01-status-actions.png),
[`02-confirmation.png`](walkthrough/test-all-ai-tasks/02-confirmation.png),
[`03-running.png`](walkthrough/test-all-ai-tasks/03-running.png) and
[`04-mixed-results.png`](walkthrough/test-all-ai-tasks/04-mixed-results.png).

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

## Consent and privacy

Saving an API key does not grant consent. Each cloud/private-network provider has
its own consent flag, and a task uses only the provider configured for its
household. Audio is sent only to the selected transcription provider. Retired illustration
and label-headline tasks cannot be configured or tested. Borrower names, room contents, receipts,
private notes and other households' data are not included. API keys are decrypted
server-side per request and never returned to the browser or written to reports.

## Live validation not performed

Automated tests use mocked official-shaped OpenRouter catalog, STT, image and
error responses; they do not make paid/live calls. Remaining operator validation:

- a real OpenRouter key with STT/audio model access, credit/billing and provider
  terms reviewed;
- a real direct OpenAI key/model for its existing adapters;
- real speech accuracy, vision accuracy, provider availability and per-model
  limits/price behavior.
