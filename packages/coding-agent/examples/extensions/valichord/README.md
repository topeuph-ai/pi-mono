# ValiChord Extension for pi

Adds `valichord_validate`, `valichord_health`, and `/valichord` to pi.

ValiChord is a distributed peer-to-peer system for scientific reproducibility
verification. It runs 100+ structural checks on a research deposit (code, data,
documentation), optionally pairs them with a real replication verdict from an AI
validator, and writes the outcome as a **HarmonyRecord** — a tamper-evident
entry on a Holochain network. The record carries a cryptographic hash that
anyone can independently verify.

---

## What the extension provides

### Tool: `valichord_validate`

Submits a research deposit ZIP to ValiChord and returns the HarmonyRecord.

| Parameter | Type | Description |
|---|---|---|
| `deposit_path` | string | Path to the deposit ZIP (absolute or relative to cwd) |
| `validator_outcome` | optional enum | `Reproduced` / `PartiallyReproduced` / `FailedToReproduce` — supply only when you have actually run the code |
| `validator_notes` | optional string | Replication notes: what ran, what failed, error messages (max 2000 chars) |

The tool handles:
- Multipart upload with streaming progress updates
- Polling `GET /result/<job_id>` every 10 s until done (25-min timeout)
- AbortSignal propagation — press Esc to cancel mid-upload
- Graceful failure when the conductor is offline (analysis completes, `harmony_record_hash` is null)

### Tool: `valichord_health`

Checks whether the ValiChord API is reachable and whether the Holochain
conductor is live. Use before a submission to surface problems early.

### Command: `/valichord`

Loads the full workflow prompt and sets up the session. Equivalent to
`/skill:valichord` but with endpoint info injected automatically.

---

## Installation

### Project-level (recommended)

```bash
# from your project root
mkdir -p .pi/extensions/valichord
cp /path/to/examples/extensions/valichord/index.ts .pi/extensions/valichord/index.ts
cp /path/to/examples/extensions/valichord/package.json .pi/extensions/valichord/package.json
```

pi loads all extensions in `.pi/extensions/` automatically at startup.

### Global

```bash
mkdir -p ~/.pi/agent/extensions/valichord
cp /path/to/examples/extensions/valichord/index.ts ~/.pi/agent/extensions/valichord/index.ts
cp /path/to/examples/extensions/valichord/package.json ~/.pi/agent/extensions/valichord/package.json
```

### Skill (workflow prompt only — no tool)

If you want only the workflow prompt without the programmatic tool:

```bash
mkdir -p .pi/skills/valichord
cp /path/to/examples/skills/valichord/SKILL.md .pi/skills/valichord/SKILL.md
```

The skill instructs pi to call the `valichord_validate` tool if it is installed,
or fall back to `bash`+`curl` if not.

---

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `VALICHORD_BASE_URL` | `http://localhost:5000` | ValiChord API base URL |
| `VALICHORD_API_KEY` | _(none)_ | API key, sent as `X-ValiChord-Key` header |

Set these in your shell profile, a `.env` file, or pi's settings:

```bash
export VALICHORD_BASE_URL=https://valichord.example.org
export VALICHORD_API_KEY=your-key-here
```

---

## Usage

### Validator workflow (you run the code first)

```
/valichord
→ pi: Are you a researcher or a validator?
You: validator
→ pi: What deposit should I replicate?
You: /path/to/deposit.zip
→ pi runs the code via bash, forms a verdict
→ pi calls valichord_validate(deposit_path, validator_outcome, validator_notes)
→ pi presents the HarmonyRecord hash
```

### Researcher workflow (deposit submission only)

```
/valichord
→ pi: Are you a researcher or a validator?
You: researcher
→ pi: What deposit should I submit?
You: /path/to/deposit.zip
→ pi calls valichord_validate(deposit_path) — no outcome
→ pi presents the structural findings and provisional verdict
```

### Direct tool call

```
valichord_health()
→ ValiChord API: ok (v1.0) | Conductor: live ✓ | Endpoint: http://localhost:5000

valichord_validate(
  deposit_path: "/home/user/projects/my-study/deposit.zip",
  validator_outcome: "PartiallyReproduced",
  validator_notes: "main.py ran but Figure 3 values differ by ~8% — numpy seed not fixed"
)
```

---

## Two modes, one tool

| Mode | `validator_outcome` | `validator_attested` in response | What it means |
|---|---|---|---|
| **Validator** | Supplied | `true` | You ran the code; this is a real reproducibility verdict |
| **Researcher** | Omitted | `false` | Structural assessment only; a real verdict is pending until a validator runs it |

The distinction matters: a tidy deposit can still fail to reproduce. `validator_attested: true` is the signal that someone actually executed the code.

---

## ValiChord API reference

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Liveness check + conductor status |
| `/validate` | POST | Submit deposit; returns `job_id` |
| `/result/<job_id>` | GET | Poll for results |
| `/download/<job_id>` | GET | Download full cleaning report ZIP |
| `/docs` | GET | Swagger UI |
| `/openapi.yaml` | GET | OpenAPI 3.0 spec |

Full API documentation: `GET ${VALICHORD_BASE_URL}/docs`

---

## ValiChord project

- Repository: [topeuph-ai/ValiChord](https://github.com/topeuph-ai/ValiChord)
- Architecture: four-DNA Holochain network (researcher repository, validator workspace, attestation, governance)
- Protocol: blind commit-reveal — validators cannot see each other's assessments before committing
- Record: HarmonyRecord written to the Governance DHT; verifiable by anyone with the hash
