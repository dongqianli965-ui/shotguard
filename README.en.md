# SHOTGUARD

[中文](README.md) | **English**

> **Automated acceptance testing for AI-generated video — feed it a clip, it tells you what broke.**

Every AI video platform (Kling, Dreamina, Seedance, Runway, Vidu, Pika) solves "*how do I generate something better*".
**None of them solve "*is the clip I just generated actually broken*".**

SHOTGUARD covers that gap: **post-generation acceptance testing.**

---

## First, the honest part: when this tool is useless

This project started from a fair challenge:

> **"Can't you just see with your own eyes whether the character or scene broke?"**

**That challenge is largely correct.** So here is the boundary, up front:

| Your situation | This tool |
|---|---|
| 5–10 clips/month, single character, short duration, time to review frame by frame | ❌ **Not for you — your eyes are enough** |
| Subtle drift (a sofa became a bed, a hairpin switched sides) | ✅ Useful — **your brain fills in the gap and misses it** |
| Cross-shot continuity (inconsistency only visible *between* frames) | ✅ Useful — **every individual frame looks "fine"** |
| Batch delivery, 50+ clips/month | ✅ Useful — **nobody can review that much by hand** |

**It does not replace your eyes. It covers the three places your eyes fail**: the subtle, the cross-shot, and the too-much-to-check.

> Real data in [`cases/`](cases/): three real samples — including one where **even a well-engineered structured prompt still broke.**

---

## What it detects

8 failure categories, evaluated frame by frame:

| Failure | Description |
|---|---|
| Identity drift | Face, hairstyle, or clothing diverges from the reference |
| Clothing drift | Garment style, color, or wearing state changed |
| Prop drift | Props appear from nowhere or vanish |
| Spatial drift | Scene structure changed (doors, windows, furniture, left/right relations) |
| Lighting drift | Light source or shadow direction flipped |
| State rollback | Weather, time of day, or damage state reverted without cause |
| Action break | Empty shot (no subject in frame) or discontinuous action |
| Audio break | ⚠️ Not supported yet (requires audio analysis) |

---

## Quick start

### Requirements

1. An AI-generated video (MP4 / MOV / WebM)
2. A character reference image
3. Two short descriptions (character appearance + scene)
4. A **vision-capable** model API (OpenAI-compatible)

### Option 1: CLI (full functionality)

```bash
# Configure once
export VISION_API_BASE_URL="https://api.openai.com/v1"
export VISION_API_KEY="sk-..."
export VISION_MODEL="gpt-4o"

# Run verification
node src/shotguard-verify.js "video.mp4" "character.png" "character description" "scene description"
```

**Two artifacts are produced:**

- `verify_report.json` — structured data for programmatic use
- `verify_report.html` — **a client-ready report** with every sampled frame embedded (single file, ~5 MB, zero external dependencies)

### Option 2: Browser

Open [`index.html`](index.html) and fill in the form.

> ⚠️ Browsers cannot invoke ffmpeg for frame extraction, so the web version is a **lightweight demo**. Use the CLI for full functionality.

### Try it without preparing your own footage

The [`demo/`](demo/) directory ships with **real test footage** — one character, one scene, three different prompt styles — so you can run it end to end without preparing anything:

```bash
cd demo
node ../src/shotguard-verify.js \
  case-a-naive-prompt.mp4 \
  reference-character.png \
  "17-year-old girl, black shoulder-length straight hair, silver hairpin on the right side, beige knit cardigan over a white shirt, faint freckles" \
  "wooden floor, white walls, floor-to-ceiling window on the right, grey fabric sofa beneath it"
```

See [`demo/README.md`](demo/README.md) for all three prompt versions and expected results.

---

## API compatibility

Requires a **vision (image-reading)** model. Any OpenAI-compatible endpoint works:

| Provider | Base URL | Model example |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Claude | `https://api.anthropic.com/v1` | `claude-3-5-sonnet` |
| Qwen-VL | `https://dashscope.aliyuncs.com/v1` | `qwen-vl-max` |
| Gemini | `https://generativelanguage.googleapis.com/v1` | `gemini-pro-vision` |
| Doubao Vision | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-vision` |
| Local deployment | your own | your own |

**Not supported:** image *generation* APIs (DALL·E, Midjourney) — they produce images, they cannot read them.

---

## Real results

All three samples share the **same character, same scene, same action** — the only variable is prompt style.

| Case | Prompt | Detection result | Report |
|---|---|---|---|
| **A** | Naive (18 chars) | 4 categories failed (identity / prop / spatial / lighting) | [HTML](cases/case-a-naive-prompt.html) |
| **B** | Long but unstructured (568 chars, atmosphere only) | High proportion of undecidable frames | [HTML](cases/case-b-long-unstructured.html) |
| **C** | Structured (588 chars, with scene anchors + fingerprint lock) | **Still 3 categories failed** | [HTML](cases/case-c-structured-prompt.html) |

**Case C is the point**: even a carefully engineered structured prompt **cannot 100% prevent breakage**.

This matches the [PersonaShot benchmark (arXiv:2608.16717)](https://arxiv.org/abs/2608.16717) — cross-shot continuity degrades roughly 25% in visual quality and 50% in affective expression versus single-shot generation. From the paper:

> *"Even visually compelling videos frequently exhibit physical-state resets, abrupt affective shifts, and broken cinematic relations across shots."*

**Even the best prompt needs verification.**

> The case reports are ~5 MB each because every frame is embedded, so they can be delivered as a single file.

---

## Known limitations

1. **No audio-break detection** — visual only; audio analysis is unimplemented
2. **Blurry frames are undecidable** — dark or motion-blurred frames are marked "undecidable" rather than force-judged
3. **Back-facing frames limit some dimensions** — without a visible face, identity drift can only be inferred from hair and clothing
4. **Model rate limits** — 429 exponential backoff (2s → 4s → 8s) and inter-frame spacing are built in; budget your quota for batch runs
5. **Confidence varies** — "confidence" in the report = successfully judged frames / total frames. Low confidence means the sample quality was insufficient, not that the tool failed

---

## Project structure

```
├── index.html                      # Browser version (lightweight demo)
├── src/
│   └── shotguard-verify.js         # CLI (full functionality)
├── demo/                           # Real test footage + all three prompts
├── cases/                          # Three real acceptance reports
│   ├── case-a-naive-prompt.html
│   ├── case-b-long-unstructured.html
│   └── case-c-structured-prompt.html
└── docs/
    ├── USAGE.md                    # Detailed usage guide
    └── ARCHITECTURE.md             # Detection internals and design rationale
```

---

## How it works

- **Frame extraction** — ffmpeg / ffprobe, uniformly sampled (6 frames by default)
- **Detection** — the reference image and the current frame are both sent to a vision model, which must return structured JSON
- **Fault tolerance** — when the model returns nothing usable, the frame is marked "undecidable" rather than misjudged
- **Rate limiting** — 429 exponential backoff (2s → 4s → 8s, max 3 retries) plus 1.5s spacing between frames
- **Reporting** — JSON plus a self-contained HTML report (images inlined as base64, deliverable as one file)

> For the full rationale — why "undecidable" is a first-class outcome, why there are zero
> dependencies, and why audio detection is deliberately omitted — see
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- ffmpeg / ffprobe on `PATH`

No npm dependencies — the project deliberately has zero `dependencies`.

---

## License

MIT

---

## Background

This project came out of a complete self-falsification exercise.

The original idea was to sell "prompt engineering as a service". During market due diligence,
that thesis collapsed: the only academic support had been cited out of context,
a 397B prompt-enhancement model had already automated the work for free,
and the pricing was an order of magnitude above the real market.

**So the original plan was scrapped, and the project pivoted to the one thing no platform does:
post-generation verification.**

The full record — including the parts that failed — is preserved in the project history,
because a falsified hypothesis is worth more than an unverified one.
