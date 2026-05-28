# Recommendation: Escalation 1 — contract-vision:c8 (OpenAI billing surfaces)

**Recommended option:** A

**Confidence:** high

## Why

The "What it isn't" table at `reference/vision.md:127` reads "No OpenAI,
Gemini, Llama, model swapping" and the justification column is "No OpenAI,
Gemini, Llama, model swapping." Outcome 3 at `reference/vision.md:76-84`
states "No Agent SDK. No API-key routing. No raw API." Reading these in
context, the constraint is about inference model routing — the pillar is
that every *agent turn* runs through the unmodified `claude` CLI on the
Pro/Max subscription, not via a metered API. Neither Whisper nor an
OpenAI embedding provider is an inference model for agent turns.

The two surfaces in question are structurally different from the prohibited
pattern:

**Voice-in (Whisper).** The feature is explicitly opt-in per agent —
`src/config/schema.ts:588` documents it as "Off by default — opt-in per
agent", and `src/cli/telegram.ts:154-188` is a CLI verb the operator must
actively invoke. No fresh `switchroom setup` enables it. The docs
(`docs/telegram-features.md:53-57`) already contain a self-aware tradeoff
note: "That's the one place Switchroom asks you to leave the Pro/Max-only
ceiling — there's no Anthropic-side voice transcription yet." This is
precisely the kind of explicit, acknowledged, opt-in auxiliary service that
Option A would legitimise in writing.

**Hindsight embedding provider field.** The `openai` and `anthropic`
choices listed in the schema description at `src/config/schema.ts:1692-1693`
appear to be vestigial spec text from an earlier design of Hindsight.
At runtime, `src/memory/hindsight.ts:42` reads `memoryConfig.config?.provider
?? "ollama"`, so the *default* is `ollama` (local, no API key). More
importantly, `src/cli/memory.ts:292-300` actively *ignores* any
`--provider` flag other than `claude-code` — the switchroom-bundled
Hindsight image is pinned to `HINDSIGHT_API_LLM_PROVIDER=claude-code` (see
`docs/auth.md:325,367-369`), which uses the operator's OAuth credentials
via the auth-broker. The `api_key` field in the schema
(`src/config/schema.ts:1698-1701`) flows into `generateDockerComposeSnippet`
at `src/memory/hindsight.ts:49-51`, but only as a passthrough env var to an
arbitrary Hindsight image the operator supplies — it is not a first-class
switchroom-managed OpenAI billing surface. In practice, the schema text
advertising `openai` as a provider is currently dead for any operator
running the bundled image.

Option A — adding a carve-out paragraph to `reference/vision.md` — is the
honest fix. The vision's "No OpenAI" line was written to foreclose *model
swapping* (routing agent turns through GPT-4 or Gemini instead of Claude),
not to prohibit every third-party API a user might separately subscribe to
for auxiliary tasks like speech-to-text. Whisper is a transcription
preprocessor, not an inference substitute; the agent still runs every
response through the `claude` CLI. Codifying this distinction removes the
apparent contradiction and gives future contributors a clear rule: auxiliary
services the operator pays for separately and opts into explicitly are in
scope; anything that routes Claude agent turns away from the subscription is
not.

## Tradeoffs of the recommendation

- Amending the vision requires care: the carve-out language must be narrow
  enough not to open the door to "optional" OpenAI inference paths by
  analogy. The text should say "auxiliary services" and require explicit
  opt-in — not become a general "third-party APIs are fine" waiver.
- The Hindsight embedding schema fields (`openai`, `anthropic` as provider
  values, `api_key`) describe configuration that is currently unreachable
  via `switchroom memory --start` (which pins `claude-code`). Leaving them
  in the schema without documenting their status as out-of-maintenance or
  removing them is a low-level documentation debt — Option A should note
  this for a follow-up cleanup, even if it does not require a code change
  now.
- Accepting the carve-out implicitly accepts that voice-in creates a second
  billing relationship (OpenAI) for the operator. This is already disclosed
  in `docs/telegram-features.md:53-57`, but the vision doc change should
  echo that disclosure so the tradeoff is visible to contributors, not only
  to operators reading the feature docs.
- If Anthropic or a third-party later ships subscription-level transcription
  via the `claude` CLI, voice-in should migrate to that path. The amended
  vision text should include a sunset clause ("until a subscription-native
  transcription path exists").

## If you pick a different option

- **Option B (restrict the features):** Removing Whisper entirely eliminates
  the one user-visible capability that lets a principal send voice notes from
  their phone — a real loss for Outcome 4 ("always available, done properly")
  and a regression against JTBD users who are already relying on it. Removing
  the embedding provider schema fields for `openai`/`anthropic` is lower
  cost — those fields are unreachable in the standard image — but requires
  a migration path for any operator who has set them. Option B is the right
  answer only if the operator decides that policy-level consistency with the
  vision text is more important than the feature; that is a product judgment
  call, not a technical one.
- **Option C (defer):** Deferral leaves contributors with a visible
  contradiction between the vision and the code that audit will flag again
  on the next pass. It also leaves the docs (`telegram-features.md:53-57`)
  as the only place where the tradeoff is acknowledged, which is too
  peripheral for a constraint as load-bearing as Outcome 3. Option C is
  acceptable only if the operator wants to evaluate a subscription-native
  transcription path before committing to the carve-out language.

## Open question for the operator

The `memory.config.provider` schema field (`src/config/schema.ts:1690-1693`)
lists `openai` and `anthropic` as valid values, but `switchroom memory
--start` ignores them and the bundled image is pinned to `claude-code` — are
these provider values intended for operators bringing their own Hindsight
image, or are they dead schema text that should be removed?
