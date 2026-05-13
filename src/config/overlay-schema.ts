/**
 * Overlay-document schema for per-agent `schedule.d/*.yaml` files.
 *
 * Overlays are write-tool-managed YAML fragments that a future agent-config
 * MCP write surface (Phase C of switchroom #1163) will create on the agent's
 * behalf. Each file under `~/.switchroom/agents/<name>/schedule.d/` is a
 * standalone YAML document that *appends* to the main `switchroom.yaml`
 * config — it cannot override entries declared in the main file.
 *
 * The shape is intentionally narrow: only `schedule` (a list of
 * `ScheduleEntrySchema` entries) is accepted right now. `skills` is reserved
 * but not yet wired (the main-config `skills:` field is `string[]`, not a
 * structured-entry list, so an overlay-append model needs a separate design
 * pass — see the loader's `applyAgentOverlays` for the matching TODO).
 *
 * Anything else at the top level is a hard-reject — operators editing
 * overlays by hand should get a clear error rather than silent acceptance
 * of typos.
 */
import { z } from "zod";
import { ScheduleEntrySchema } from "./schema.js";

export const OverlayDocSchema = z
  .object({
    schedule: z.array(ScheduleEntrySchema).optional(),
    // Reserved for Phase C+ — the loader currently ignores this key so
    // that an early-adopter writing `skills:` in an overlay doesn't get a
    // hard reject before the merge semantics ship. Schema-level we still
    // require it to be the right *type* if present.
    skills: z.array(z.string()).optional(),
  })
  .strict();

export type OverlayDoc = z.infer<typeof OverlayDocSchema>;
