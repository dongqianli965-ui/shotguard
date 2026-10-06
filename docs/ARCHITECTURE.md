# Architecture · How SHOTGUARD detects breakage

> This document explains the detection pipeline, the design decisions behind it,
> and — importantly — **why certain things are deliberately not implemented**.

---

## 1. The core problem

AI video platforms solve *generation*. They do not solve *verification*.

They approach "consistency" as an **input-side** feature: feed the model a reference image,
register a character, bind elements. That raises the *probability* of consistency.
It does not tell you whether the clip you just produced actually **is** consistent.

SHOTGUARD lives on the **output side**: given a finished clip plus the reference the clip
was supposed to honour, decide frame by frame whether it held up.

The two sides are complementary, not competing:

```
   reference image ──► [ platform ] ──► video clip ──► [ SHOTGUARD ] ──► report
                        input-side                       output-side
                     (raise probability)              (verify outcome)
```

---

## 2. The pipeline

```
video.mp4
   │
   ├─(1) probe duration ────────── ffprobe
   │
   ├─(2) extract N frames ──────── ffmpeg, uniform sampling
   │
   ├─(3) per frame: compare against reference
   │        │
   │        └─► vision model (reference + frame) ──► JSON verdict
   │
   └─(4) aggregate ───────────────► verify_report.json
                                    verify_report.html
```

### Step 1 — Duration probe

`ffprobe` reads the container duration. If it fails, a 5-second default is assumed
rather than aborting — a wrong sample interval is recoverable; a hard failure is not.

### Step 2 — Uniform frame sampling

Frames are sampled at `duration / (N + 1) * i` for `i = 1..N`, i.e. **evenly spaced with
half-gaps at both ends**, rather than including the very first and last frames.

**Why not the first/last frame?**
The first frame of an AI-generated clip is frequently a near-empty establishing shot
(a door, a wall, an empty room) because the model is still "setting up" the scene.
Sampling it wastes a slot on a frame that carries almost no continuity information.
Default `N = 6`, configurable.

**Known trade-off:** uniform sampling can miss a *brief* breakage between sample points.
Raising `N` narrows the gap linearly in cost. This is the same trade-off any
keyframe-based inspection makes.

### Step 3 — Reference-conditioned verdict

Each frame is sent to a vision model **together with the reference image**, in a single
request, with a prompt demanding strict JSON output across 7 categories:

```
{ "identity_drift": bool, "clothing_drift": bool, "prop_drift": bool,
  "spatial_drift": bool, "lighting_drift": bool, "state_rollback": bool,
  "action_break": bool, "issues": [string] }
```

**Why send the reference every time** instead of describing the character in text?
Because the whole point is catching drift *relative to the intended target*.
A text description loses exactly the details that drift first — the side a hairpin sits on,
the hue of a cardigan, the presence of a sofa under a window. The reference image carries
those details losslessly.

**Why strict JSON?** The verdict must be machine-aggregatable across frames. Free-form prose
cannot be counted, compared, or thresholded.

### Step 4 — Aggregation

Per-category failure counts, an overall pass/fail, and a confidence figure:

```
confidence = successfully judged frames / total frames
```

---

## 3. Design decisions

### 3.1 "Undecidable" is a first-class outcome

If the model returns nothing usable — empty content, refusal, malformed JSON after two
extraction attempts — the frame is recorded as **`uncertain: true`**, not as a pass and not
as a failure.

**This is the single most important design decision in the project.**

A verification tool that guesses is worse than no tool at all:

- Guess "pass" → false negative → broken clip ships to a client
- Guess "fail" → false positive → user stops trusting the tool and abandons it

Real-world cause: motion-blurred frames and back-facing frames genuinely do not contain
enough evidence. The honest answer is *"I cannot tell"*, and that answer must be visible in
the report — hence the confidence metric. A report at 33% confidence is not a failure of the
tool; it is the tool telling you the sample was too poor to judge.

### 3.2 Rate-limit handling: exponential backoff

Vision calls are the bottleneck and the cost. Providers return HTTP 429 under load.

The implementation retries on 429 with exponential backoff — **2s → 4s → 8s, max 3 attempts** —
and additionally spaces consecutive frames by **1.5s** to avoid tripping the limit in the
first place.

**Why not just retry harder?** Because the upstream message in practice is often
*"temporarily rate-limited; do not switch accounts or replay requests during cooldown"* —
hammering makes it worse. Backing off respects the provider and produces fewer failures
overall.

### 3.3 Zero npm dependencies

`package.json` has an empty `dependencies`. The project uses only:

- Node's built-in `fetch` (Node 18+)
- Node's built-in `child_process` to invoke `ffmpeg` / `ffprobe`
- Node's built-in `fs` / `path`

**Why?** A verification tool that cannot be trusted to keep running is useless. Every
dependency is a future supply-chain, version-conflict, or abandonment risk. The external
surface here is exactly two well-known CLI binaries that have existed for over a decade.

### 3.4 Self-contained HTML report

The HTML report inlines every frame as base64. A 6-frame report is ~5 MB.

**Why not link to image files?**
Because the report is a *deliverable*. It gets emailed, dropped into a chat, attached to a
ticket. A report that breaks when moved is not a deliverable. 5 MB is an acceptable price
for a file that always opens.

### 3.5 No audio analysis (deliberate omission)

`Audio break` is listed in the category table and marked **not supported**.
The detector returns `null` for it rather than fabricating a verdict.

**Why not implement it?** Audio continuity (reverb space, ambience bed persistence) is a
genuinely different signal-processing problem from visual drift. Bolting a half-working
audio path onto a visual tool would produce confidently wrong verdicts — precisely what
§3.1 exists to prevent. It belongs as a separate detector, not as a checkbox here.

---

## 4. Failure taxonomy

| Category | What it asks | Typical evidence |
|---|---|---|
| Identity drift | Is this the same person? | Face shape, hairstyle length/parting, distinguishing marks |
| Clothing drift | Is this the same outfit? | Garment type, colour, fastening state, accessories |
| Prop drift | Are the props where they were? | Object presence/absence, which hand, worn state |
| Spatial drift | Is this the same place with the same layout? | Doors, windows, furniture position, left/right relations |
| Lighting drift | Is the light coming from the same direction? | Lit side of the face, shadow direction, colour temperature |
| State rollback | Did anything revert? | Damage healing, weather clearing, time jumping backwards |
| Action break | Is there a subject, and does the action connect? | Empty frame, no subject, disjointed motion |
| Audio break | *(not implemented — see §3.5)* | — |

---

## 5. What this tool is not

Stated plainly, because a tool that oversells itself gets abandoned after the first
disappointment:

- **Not a generator.** It never produces or modifies video.
- **Not a guarantee.** It samples frames; breakage between sample points can be missed.
- **Not an aesthetic judge.** It checks *conformance to the reference*, not whether a shot
  is beautiful or whether the story works.
- **Not a replacement for human review** on small volumes. Below roughly 10 clips/month with
  time to inspect frame by frame, your eyes are genuinely sufficient — this is documented in
  the [README](../README.md) as an explicit limitation rather than buried.

---

## 6. Extension points

If you want to extend the tool, these are the intended seams:

| Goal | Where to change |
|---|---|
| Support a new vision API shape | `callVisionAPI()` in `src/shotguard-verify.js` |
| Change frame count / sampling strategy | `extractFrames()`, or add a CLI flag |
| Add a detection category | Extend the prompt's JSON schema, the `failCounts` map, and the report template |
| Feed a batch of clips | Wrap `verifyVideo()` in a loop; mind the rate-limit spacing |
| Emit a different report format | `generateHTMLReport()` — JSON output is already machine-readable |

The two functions worth reading first are `extractFrames()` and `callVisionAPI()` —
together they are the entire detection core.

---

## 7. Why any of this exists

The project began as an attempt to sell prompt engineering as a service. Due diligence
falsified that thesis: the sole academic citation had been used out of context, a 397B
prompt-enhancement model had already automated the work, and the pricing sat an order of
magnitude above the real market.

Rather than defend a dead hypothesis, the effort moved to the part every platform skips.
The [README](../README.md) keeps that history visible on purpose — including the parts that
did not work — because a falsified assumption is more informative than an untested one.
