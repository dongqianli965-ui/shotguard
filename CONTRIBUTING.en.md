# Contributing to SHOTGUARD

[中文](CONTRIBUTING.md) | **English**

Thanks for considering a contribution.

> Want the detection internals first? See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## What this project needs most

In priority order:

1. **More real-world cases** — different failure types, different generation models (Kling, Runway, Vidu, Pika, Wan), different scene types
2. **New detection dimensions** — especially **audio break** (entirely unimplemented; needs audio analysis)
3. **Accuracy feedback** — if you find a false positive or false negative, please include the frame image and your reasoning
4. **API adapters** — support for vision-model response formats beyond OpenAI's

---

## Reporting issues

Open an [Issue](../../issues) and include as much of the following as you can:

- The generation model and version (e.g. Kling 2.5, Runway Gen-4)
- The raw vision-model response (**redacted** — remove any API keys)
- Characteristics of your clip/reference (back-facing? blurred? multiple subjects?)
- Expected vs actual verdict

### Check the known boundaries first

Before filing, confirm your case is not one of these documented limitations:

| Symptom | Known? | Cause |
|---|---|---|
| Blurred frames marked "undecidable" | ✅ Known | The model cannot extract evidence from dark or motion-blurred frames — **this is intentional** (see [ARCHITECTURE §3.1](docs/ARCHITECTURE.md)) |
| No identity drift detected in back-facing shots | ✅ Known | Without a visible face, only hair and clothing can be compared |
| Audio break never detected | ✅ Known | Not implemented ([§3.5](docs/ARCHITECTURE.md)) |
| Reported confidence below 100% | ✅ Known | Confidence = judged frames / total frames |

**False positives are more damaging than false negatives** in this tool — a user who is told a
good clip is broken will stop trusting it. If you find a false positive, please file it; those
take priority over everything else.

---

## Submitting code

1. Fork the repository
2. Create a branch: `git checkout -b feat/your-feature`
3. **Run the checks locally before pushing**:

```bash
node --check src/shotguard-verify.js
node src/shotguard-verify.js        # should print usage
```

4. Commit: `git commit -m "feat: your feature"`
5. Push and open a Pull Request

CI runs on Linux and Windows across Node 18 / 20 / 22. It must be green.

---

## Code conventions

- **Plain Node.js, no dependencies** — the project deliberately keeps `dependencies` empty.
  Use Node built-ins plus `ffmpeg`/`ffprobe` only. If you believe a dependency is genuinely
  unavoidable, open an issue first and argue for it.
- **Failures must be explicit** — when a frame cannot be judged, mark it `uncertain`.
  Never guess a verdict to make output look complete. See [ARCHITECTURE §3.1](docs/ARCHITECTURE.md).
- **Comments in Chinese** — matching the existing codebase.
- **Never commit secrets** — no API keys in code, config, fixtures, or commit messages.
  CI scans for this and will fail the build.

---

## Please don't

- ❌ Turn the tool into a paid-only or license-gated form
- ❌ Remove the "when this tool is useless" section from the README — stating plainly where
  the tool does *not* help is a founding principle of this project, not an oversight
- ❌ Loosen detection criteria just to make runs "succeed". Reporting "undecidable" is
  preferable to reporting a confident wrong answer
- ❌ Add telemetry, phone-home behaviour, or network calls beyond the user's own configured
  vision API endpoint

---

## Adding a detection category

If you want to add a new failure dimension, three places must change in sync:

1. The JSON schema in the prompt inside `callVisionAPI()`
2. The `failCounts` map in `verifyVideo()`
3. The category table in both `README.md` and this file's documentation surface

A category that is only partially wired up produces misleading reports — worse than not
having it. If you cannot implement it end to end, document it as unsupported instead
(the `audio break` entry is the model to follow).

---

## License

Contributions are licensed under [MIT](LICENSE).
