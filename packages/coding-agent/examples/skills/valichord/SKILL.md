---
name: valichord
description: Submit a research deposit to ValiChord for reproducibility verification. Use when asked to verify, replicate, validate, or audit a research study, or when the user wants a HarmonyRecord — a cryptographic proof that the code was independently reproduced.
---

# ValiChord Validation Workflow

ValiChord is a distributed system for scientific reproducibility verification. It uses a blind commit-reveal protocol on a peer-to-peer network (Holochain) to produce **HarmonyRecords** — cryptographically tamper-evident proofs that independent parties reproduced the same findings without coordinating.

**What "Reproduced" means:** the validator independently ran the same code and arrived at the same results as the researcher. It does NOT mean the result is scientifically correct — a study can be reproducible and wrong. ValiChord only answers the reproducibility question.

Your role: **AI validator**. You actually run the code (via the `bash` tool), form your own verdict from evidence, and submit it. ValiChord records it permanently. Not a proxy, not an estimate — what you found when you ran it.

---

## Step 1: Establish role and deposit

Ask the user:

1. **Role** — are you the **researcher** (depositing your own study for others to verify) or a **validator** (independently verifying someone else's study)?
2. **Deposit** — a ZIP file path, a local directory, or a public repository URL.
3. **ValiChord API base URL** — default `http://localhost:5000`. Check `VALICHORD_BASE_URL` env var.

Researchers skip to Step 3. Validators continue to Step 2.

---

## Step 2: Run a replication attempt (validators only)

**This is the core job.** Do not just inspect files — actually install the environment and execute the research code.

Ask which execution environment to use:
- **Docker** — recommended; isolated, reproducible
- **Local** — quick, but environment drift possible
- **Modal** — serverless GPU; use for GPU-heavy workloads
- **RunPod** — persistent GPU pods; for long-running training

Then:

1. Read the README and environment specification files to understand setup requirements.
2. Install the environment and execute the research code using the `bash` tool.
3. Record:
   - Whether the code ran to completion without errors
   - Whether outputs matched the researcher's claimed results (numbers, figures, metrics)
   - Any specific step that failed and the exact error message
   - The environment used (OS, language version, key package versions)

4. Form your verdict from what you directly observed — not from inspecting files:

   | Verdict | Meaning |
   |---|---|
   | `Reproduced` | Code ran; outputs match within reasonable tolerance |
   | `PartiallyReproduced` | Code ran but outputs differ in specific ways — document what differed and by how much |
   | `FailedToReproduce` | Code failed to run, or outputs were fundamentally different — document exactly where it failed and why |

5. Write concise replication notes covering: what ran, what didn't, specific error messages, and why you chose your verdict. Max 2000 characters.

Save notes to `outputs/<slug>-replication-notes.txt`.

---

## Step 3: Package the deposit

ZIP the deposit if it is not already a ZIP. Include all source files, data, documentation, and environment specifications. Exclude large generated artefacts (model weights, large outputs) not in the original deposit.

Save to `outputs/<slug>-deposit.zip`.

---

## Step 4: Submit to ValiChord

### Validator path — fast, synchronous (~60 s)

If the `valichord_validate` tool is available, call it directly:

```
valichord_validate(
  deposit_path: "outputs/<slug>-deposit.zip",
  validator_outcome: "Reproduced" | "PartiallyReproduced" | "FailedToReproduce",
  validator_notes: "<your replication notes>"
)
```

This calls `POST /attest` on the ValiChord API. It runs the full Holochain commit-reveal protocol and returns the HarmonyRecord directly — no polling required.

If the tool is not installed, use curl:

```bash
curl -s -X POST "${VALICHORD_BASE_URL:-http://localhost:5000}/attest" \
  -F "file=@outputs/<slug>-deposit.zip" \
  -F "outcome=Reproduced" \
  -F "notes=<replication notes>" \
  ${VALICHORD_API_KEY:+-H "X-ValiChord-Key: $VALICHORD_API_KEY"}
```

Response (synchronous — no polling needed):

```json
{
  "data_hash": "<sha256 hex>",
  "outcome": "Reproduced",
  "validator_attested": true,
  "harmony_record_hash": "<uhCkk... ActionHash or null>",
  "harmony_record_url": "<gateway URL or null>"
}
```

Save to `outputs/<slug>-harmony-record.json`.

### Researcher path — structural analysis (~5–20 min)

```
valichord_validate(
  deposit_path: "outputs/<slug>-deposit.zip"
)
```

This calls `POST /validate` and returns a `job_id`. Poll `GET /result/<job_id>` every 10 s until `status` is `"done"`. See Step 5 for polling.

Researchers: include no `outcome`. ValiChord derives a provisional assessment from deposit structure until a validator attests (`validator_attested` will be `false`).

---

## Step 5: Poll for results (researcher path only)

```bash
curl -s "${VALICHORD_BASE_URL:-http://localhost:5000}/result/<job_id>"
```

Poll every 10 seconds until `status` is `"done"` or `"error"`. Timeout after 25 minutes.

Response when done:

```json
{
  "status": "done",
  "prs": 0.87,
  "harmony_record_draft": {
    "outcome": { "type": "Reproduced" },
    "validator_attested": false,
    "data_hash": "<sha256 hex>",
    "findings_summary": { "critical": 0, "significant": 2, "low_confidence": 3, "total": 5 },
    "harmony_record_hash": "<uhCkk... ActionHash or null>",
    "harmony_record_url": "<gateway URL or null>"
  },
  "top_findings": [...],
  "download_url": "/download/<job_id>"
}
```

Save the full response to `outputs/<slug>-harmony-record.json`.

---

## Step 6: Present findings

**For validators:**
- **Replication result** — what you ran, what succeeded, what failed (with specifics)
- **Verdict** — `outcome` and `validator_attested: true` (confirms this is a real verdict, not a proxy)
- **Harmony Record hash** — `harmony_record_hash` (the permanent cryptographic record on the peer-to-peer network)
- **Harmony Record URL** — `harmony_record_url` if non-null (publicly verifiable, no login required)

**For researchers:**
- **Structural assessment** — key issues from `top_findings`
- **Provisional verdict** — note this is based on deposit structure, not actual execution; will be updated when a validator runs the code
- **Harmony Record hash** — the permanent record of this submission
- Download link for the full cleaning report: `GET /download/<job_id>`

---

## Notes

- ValiChord's blind commit-reveal protocol means validators cannot see each other's assessments before committing. Do not share your verdict before submitting.
- AI agents (including yourself) are valid validators. Your attestation carries the same cryptographic weight as a human validator's.
- `harmony_record_hash` is null when the Holochain conductor is not running. The analysis results are always returned regardless.
- `harmony_record_url` is null until a permanent HTTP Gateway is deployed. The hash is always the authoritative identifier.
- Valid `validator_outcome` values: exactly `Reproduced`, `PartiallyReproduced`, `FailedToReproduce`.
- If ValiChord is unreachable, report clearly and stop — do not silently fail or guess a verdict.
- ValiChord is NOT a blockchain. It uses Holochain — an agent-centric distributed network where each node holds its own source chain and a slice of the shared DHT. There are no tokens, no miners, no global consensus.
