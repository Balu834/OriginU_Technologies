---
name: capcut-smartcut
description: Smart-cut CapCut projects — remove silences and duplicate takes from talking-head videos using CapCut's auto-generated subtitles, plus list/inspect projects and edit/split/merge subtitles. Use when the user says "smart cut", "cut my CapCut project", "remove silences", "remove duplicate takes", "show my CapCut projects", "fix my captions", or anything about editing CapCut drafts/subtitles.
argument-hint: [project name and what to do, e.g. "smart cut Podcast Episode 5"]
---

# CapCut SmartCut

You edit CapCut projects programmatically via the bundled Python scripts in `scripts/`. Everything runs locally against the CapCut drafts folder — no MCP server, no API keys required.

## Setup (first use only)

The scripts need a venv with pydantic. Check it exists, create if not:

```bash
[ -x ~/.claude/skills/capcut-smartcut/scripts/.venv/bin/python ] || bash ~/.claude/skills/capcut-smartcut/scripts/setup.sh
```

Add `--with-openai` to setup.sh only if the user wants GPT-enhanced duplicate detection (also needs `OPENAI_API_KEY` in the environment).

## Running commands

Everything goes through one CLI (JSON in, JSON out):

```bash
~/.claude/skills/capcut-smartcut/scripts/.venv/bin/python \
  ~/.claude/skills/capcut-smartcut/scripts/cli.py <command> --args '<json>'
```

| Command | Purpose | Key `--args` fields |
|---|---|---|
| `list` | List all CapCut projects | `drafts_dir` (optional, auto-detected) |
| `open` | Inspect a project: video segments, subtitles | `project_name` (partial match) or `project_path` |
| `smart-cut` | Cut silences + duplicate takes (heuristic first pass) | `project_name`, `silence_threshold_sec` (default 1.0), `similarity_threshold` (0–1, default 0.5), `use_openai` (default false) |
| `cut-ranges` | **Apply exact cuts YOU decided** (duplicates, filler) | `project_name`, `ranges` (array of `{start_sec, end_sec}` on the current timeline; auto-merged) |
| `edit-subtitle` | Change a subtitle's text/timing | `project_name`, `segment_id`, `new_text`, `new_start_sec`, `new_duration_sec` |
| `split-subtitle` | Split a subtitle at a timeline point | `project_name`, `segment_id`, `split_time_sec` |
| `merge-subtitles` | Merge two subtitles (A absorbs B) | `project_name`, `segment_id_a`, `segment_id_b` |
| `fix-word-timing` | Set word-level timing arrays | `project_name`, `segment_id`, `words_text`, `words_start_ms`, `words_end_ms` (all same length, ms relative to segment start) |
| `batch-edit` | Multiple subtitle edits in one pass | `project_name`, `edits` (array of `{segment_id, new_text?, new_start_sec?, new_duration_sec?}`) |

Example:

```bash
.../cli.py smart-cut --args '{"project_name": "Podcast Episode 5", "silence_threshold_sec": 1.0}'
```

## Smart-cut workflow

1. Confirm prerequisites with the user: video imported into CapCut, subtitles generated (Text → Auto Captions), **CapCut closed** before editing.
2. Run `list` to find the project (or `open` to verify it has auto-subtitles).
3. **Warn the user: smart-cut modifies the project IN PLACE with no backup.** Back up the project folder first (`cp -R`) unless they decline — put the backup OUTSIDE the drafts folder (e.g. `~/Movies/CapCut/<name>-backup`) so partial name matching can never target it.
4. Run `smart-cut` for the silence gaps + first-pass duplicate removal. Report what was cut.
5. **Transcript review pass (MANDATORY — the heuristic misses things):** run `open` on the project and READ the full remaining transcript yourself. Hunt for:
   - Repeated takes of the same line — remove ALL earlier takes, **always keep the LAST take** (the speaker retried until they nailed it).
   - Partial/abandoned restarts (a fragment whose words are contained in a later fuller line).
   - Intra-caption repeats ("which is today which is today") — use the per-word `words` timings in the `open` output to compute a mid-caption cut range that removes the first repetition.
   - Stray filler fragments left hanging ("which which", lone "um"/"so").
   Compute the exact `{start_sec, end_sec}` ranges (cut from the start of the first bad word to the start of the first kept word) and apply them with `cut-ranges` in ONE call.
6. Verify: run `open` again and re-read the transcript. If any repeats remain, repeat step 5. Stop only when the transcript reads clean, with no repeated phrases.
7. Tell the user to reopen CapCut (restart it if changes don't show) and review the cuts.

## Critical Rules

1. Never run `smart-cut` or subtitle edits while CapCut is open — check with the user first.
2. Always mention the in-place / no-backup behavior before the first destructive command in a session.
3. Match projects by `project_name` (partial match works); fall back to `project_path` if names are ambiguous.
4. `use_openai: true` requires the openai package installed and `OPENAI_API_KEY` set — don't enable it silently; the default heuristic works without any keys.
5. If a command errors with "No auto-generated subtitles found", tell the user to open the project in CapCut, select the video track, use Text → Auto Captions, save, close CapCut, and retry.
6. Drafts folder is auto-detected (macOS: `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`); pass `drafts_dir` / `CAPCUT_DRAFTS_DIR` only if the user has a custom location.
7. When removing duplicate takes, ALWAYS keep the last take and remove the earlier ones — never the reverse.
8. Never skip the transcript review pass (workflow step 5–6). The heuristic alone is not good enough; you are the duplicate detector.
9. `cut-ranges` operates on the CURRENT timeline — after any cut, previously computed times are stale. Re-run `open` before computing more ranges.

Use the user's arguments to pick the project and operation. If they just say "smart cut my video" with one obvious recent project from `list`, confirm the project name before cutting.
