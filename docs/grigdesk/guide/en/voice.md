# Speaking text with voice

`voice` creates WAV audio from text using Qwen cloud synthesis through a regular API
or QwenCloud Token Plan, or local Piper and Silero engines. Ask an agent to run it,
or use `bin/voice` or `grigdesk-ctl voice`
in a source checkout. The compiled command is included in the server distribution.

## Before you begin

In a checkout, build the command with `npm --prefix voice run build`. The “All” target
of `grigdesk-ctl build` also builds it and installs other application components.
Local engines need Python3 with venv, network access and space for models and dependencies.

For cloud synthesis, set `GRIGDESK_VOICE_QWEN_API_KEY` or `DASHSCOPE_API_KEY` in the environment.
Priority is `--api-key` → `GRIGDESK_VOICE_QWEN_API_KEY` → `DASHSCOPE_API_KEY`.
Token Plan also checks `TOKEN_PLAN_API_KEY` before `DASHSCOPE_API_KEY`.
The `--api-key` flag is visible in process listings; prefer an environment variable.
The command does not read server credential files. An agent may inherit `DASHSCOPE_API_KEY`
from its Qwen executor process; this is also a valid key source.

Choose `--service model-studio` for the regular paid API or `--service qwencloud-token`
for QwenCloud Token Plan. Alternatively, set `GRIGDESK_VOICE_QWEN_SERVICE`; the default
is `model-studio`. The `sk-sp-` prefix does not distinguish Token Plan from Coding Plan.
The command does not infer the service from a key or inherit the chat executor's service.
Model Studio rejects subscription keys before network access; Token Plan checks key presence
and format, while a live request is still needed to confirm actual access.
[QwenCloud subscription API](https://docs.qwencloud.com/token-plan/best-practices/speech-synthesis).

Without `--engine`, the first ready engine wins: Qwen → Piper → Silero.
**With a ready cloud profile, text is sent to the provider and billed through its API or plan.**
Select `--engine piper`
or `--engine silero` explicitly for local speech. Failure does not trigger another engine.

## What to do

1. Run `voice engines` to see readiness and recovery instructions.
2. Install a local engine: `voice install piper` or `voice install silero`.
   Downloads are verified with SHA256 and resume after interruption. Installation succeeds
   only when the acceptance phrase produces a nonempty WAV with a verified speech peak.
3. List models with `voice models`; list voices with `voice voices --engine silero`.
4. Create an audio file, for example:

```sh
voice generate --engine piper --file russian-text.txt --out speech.wav
voice generate --engine silero --voice xenia --file stressed-russian-text.txt --pace slow
voice generate --engine qwen --file narration.txt --out narration.wav
voice generate --service qwencloud-token --engine qwen --language ru \
  --file stressed-russian-text.txt \
  --instruction "Stress the final vowel in the word meaning 'I pay'." --out speech.wav
```

`--file` takes UTF-8; use either it or `--text`. Place `+` before a vowel to mark stress.
Pace values are `slowest`, `slow`, `normal`, `fast`, `fastest`. Default voices are
Cherry for Model Studio, `longanhuan_v3.6` for Token Plan, irina for Piper and xenia for Silero.
Run `voice voices --engine qwen --service qwencloud-token` for Token Plan system and base voices
and their languages. Pass a voice ID from the list with `--voice`. Token Plan uses the text
and the voice's supported languages (`ru`, `en`, `zh`). Use `--language` to pick one explicitly.
Russian synthesis with Long An Huan was tested experimentally.
Model Studio defaults to Auto. An unknown voice is an error.

## Result

A successful `generate` saves a WAV and prints one JSON line containing the engine, model,
service, voice, path, byte size, format, `ignoredDirections` and `warnings`.
The last two fields report ignored directions and experimental stress warnings.
Without `--out`, the name contains a UTC
timestamp and random UUID. Failure preserves an existing output file. List and installation
commands support `--json`; diagnostics go to stderr. Exit codes are 0 for success,
2 for invalid arguments and 1 for execution failure.

## Limits and recovery

Canonical text limits are 600 characters for Model Studio and 2000 for Token Plan/Piper/Silero.
WAV is the only format; MP3 and automatic conversion are unavailable. The 48 Russian-capable
voices belong to Model Studio. That profile reports ignored pace, `+` stress marks and
`--instruction`. Piper applies pace, and Silero applies pace and stress. Write Latin fragments
and digits as Russian words for Silero.

Token Plan sends pace and `--instruction`. Russian `+` stress marks become combining acute
marks (U+0301) after the vowel; existing acute marks are preserved and reinforced by an instruction.
The combined instruction is limited to
1600 characters. Stress control is experimental: listening feedback was partly positive,
but the word transliterated as "stoit" remained problematic. Listen to every important line; an empty
`ignoredDirections` does not guarantee correct stress.

Piper downloads about 58 MB of model data, Silero about 145 MB plus runtime/dependencies.
The Piper voice is listed under GPLv2; Silero uses CC BY-NC-SA 4.0 for noncommercial use.
Retry installation after interruption. Wait for an active installation to finish; locks with
unknown owners are not removed automatically. An ordinary directory in place of the managed
venv requires manual investigation and is not deleted by the command.

Data directory priority is `--dir` → `GRIGDESK_VOICE_DIR` → `~/.grigdesk/voice`.
Automated tests use fake services and Python executables. Live synthesis does not replace
listening checks; real local model installations require separate verification.
Choose the voice for a presentation in the video editor. Local Qwen, Edge, Yandex, RHVoice, speech recognition
and a persistent `voice serve` session are outside this version.

## Related articles

[Dictation and meetings](speech.md) · [Presentations and videos](showcase.md)
