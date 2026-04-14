# OpenClaw → Switchroom Import

## Context

There's an export bundle at `~/code/switchroom/switchroom-export/` on this machine. It contains everything from my OpenClaw instance — persona, memory, skills, credentials, config, and working files. Read `switchroom-export/MANIFEST.md` first for the full inventory.

**⚠️ This directory contains real secrets (SSH keys, API tokens, OAuth creds) in `credentials/files/`. Do NOT commit any of it to the switchroom repo. Add `switchroom-export/` to `.gitignore` immediately if it isn't already.**

## What's in the bundle

- **`identity/`** — SOUL.md (personality), USER.md (my profile), IDENTITY.md (agent name/creature), AGENTS.md (behavior rules + delegation patterns + memory protocol), HEARTBEAT.md (periodic check config), TOOLS.md (SSH hosts, API endpoints, local infra notes)
- **`memory/`** — MEMORY.md (curated long-term memory) + `daily/` (91 daily log files, Feb 2025–Apr 2026)
- **`health-data/`** — fitness plan, supplement log, alcohol log, 21 daily health logs
- **`skills/`** — 11 custom skills with SKILL.md + scripts: compass (school), garmin (fitness), doctor-appointments (HotDoc), home-assistant, my-family-finance, ken-voice (writing style), x-api (Twitter), fully-kiosk (tablet), coolify, coolify-deploy, ziggy-relay (Discord relay)
- **`credentials/`** — `CREDENTIAL_MAP.md` (inventory of 50 credentials) + `files/` (actual secret files — SSH keys, JSON tokens, API keys)
- **`config/`** — Full OpenClaw config (openclaw.json, config.json, secrets files) showing model providers, channel setup, cron jobs, tool config, MCP servers
- **`working-files/`** — Active project docs (Buildkite narratives/specs, estate investigation docs)
- **`switchroom-yaml-draft.yaml`** — A starter switchroom.yaml I generated mapping OpenClaw agents/skills/schedules to Switchroom format
- **`skill-rewrite-notes.md`** — Per-skill analysis of every hardcoded OpenClaw path and platform-specific call that needs changing

## How to think about this

This is NOT a "dump everything in and wire it up" task. I want you to **think about the best way to bring this knowledge and capability into Switchroom's architecture**. OpenClaw and Switchroom have different designs — don't just replicate OpenClaw's patterns if Switchroom has better ones.

Specifically:

### 1. Identity & persona
OpenClaw uses separate files: SOUL.md (personality), USER.md (who I am), IDENTITY.md (agent name), AGENTS.md (behavior rules). Switchroom has `soul:` config in switchroom.yaml, SOUL.md.hbs templates, CLAUDE.md.hbs for behavior. **Should you merge these? Keep them separate? Which parts belong in switchroom.yaml soul config vs SOUL.md.hbs vs CLAUDE.md? What's the Switchroom-native way?**

### 2. Memory
OpenClaw uses file-based memory: MEMORY.md (curated long-term) + daily markdown files. Switchroom uses Hindsight (semantic memory with knowledge graphs). **Should all this get ingested into Hindsight? Some of it? Should certain files stay as files (e.g. the estate investigation notes are very structured)? What's the right seeding strategy?**

### 3. Skills
The 11 skills have scripts that hardcode OpenClaw paths (`/data/openclaw-config/credentials/...`) and use OpenClaw-specific tool calls (`memory_search`, `gateway`, `message` tool, etc.). See `skill-rewrite-notes.md` for the full analysis. **How should skills work in Switchroom? As Claude Code custom slash commands? As MCP servers? As files in the agent's skills/ dir? What needs rewriting vs what can work as-is?**

### 4. Credentials
50 credential files — mix of SSH keys, JSON OAuth tokens, plaintext API keys. **Which go in Switchroom vault? Which stay as files? How should skills reference them? Should there be a standard env var pattern?**

### 5. Scheduled tasks
OpenClaw has ~24 cron jobs (health checks, morning briefings, evening wrap-ups, email monitoring, probate monitoring, etc.). The `switchroom-yaml-draft.yaml` has these mapped to `schedule:` entries. **Review whether the schedule mapping makes sense. Some were heartbeat-style (batch multiple checks) vs cron-style (single task). Which pattern fits Switchroom better?**

### 6. Working files
Buildkite product docs, estate investigation files, etc. **These are active project context. Should they live in agent workdirs? In a shared location? Be referenced but not copied into Switchroom's tree?**

### 7. Multi-agent split
OpenClaw runs everything through one main agent. The draft switchroom.yaml proposes splitting into kengpt (general), coach (health), and ziggy (Discord). **Is this the right split? Should there be more agents? Fewer? What's the right delegation model?**

## What I want from you

1. **Read the bundle** — start with MANIFEST.md, then switchroom-yaml-draft.yaml, then skill-rewrite-notes.md, then skim the key identity files
2. **Propose an implementation plan** — not just "copy files here", but the actual Switchroom-native architecture. For each major area above, give me 2-3 approach options with pros/cons
3. **Ask me clarifying questions** — what's my priority (speed vs polish), which skills do I actually use daily vs rarely, whether I want to keep OpenClaw running in parallel during migration, etc.
4. **Flag risks** — things that will break, credentials that might expire during migration, skills that need significant rewrites
5. **Don't implement yet** — plan first, I'll approve the approach, then we execute

## Key constraints
- `switchroom-export/` must NEVER be committed to git
- Skills reference OpenClaw-specific tools that don't exist in Switchroom — need alternatives
- Some credentials are OAuth tokens with expiry — may need re-auth on Switchroom side
- ziggy-relay skill is 100% OpenClaw-specific and needs full rewrite or replacement
- The `my-family-finance` skill uses a custom Ed25519 JWT auth flow — non-trivial to port
