# Presentations and videos

This section tells the story of completed work with a script, narration, browser recording and subtitled MP4. It uses an environment already running.

## Before you start

Enable the Presentations plugin. In Settings, check the recording browser, ffmpeg, storage, script model and at least one voice or your own audio. Cloud narration and model requests may send text to a provider and cost money.

## What to do

1. Choose an available target: a permanent project environment, manual sandbox or environment of an attempt waiting for a person. A running attempt blocks recording; a ready API without a working interface is insufficient.
2. Press Record video or Choose a topic… to prepare without starting. In Video topic, check the task text, wishes, code sharing, commits and uncommitted changes. A sandbox defaults to its branch with current edits; a permanent environment does not read code by default.
3. Start analysis/building. The model proposes a brief and scenes; the server verifies actions in the live environment. Failure or an uncovered requirement stops building before a completed result is delivered. A new analysis replaces previous scenes after confirmation.
4. Open a scene and check the screen, actions, narration, caption and subtitle. Edits remain drafts when switching scenes; building saves them first. Continues previous preserves screen state but requires rerecording the whole chain.
5. Choose a voice and supported tempo, then listen to its sample and your line. Local voices have a separate install button showing size and license; some need a GPU. Synthesis does not replace your own recording.
6. For supported voices, mark stress with `+` before the vowel. Put common cases in the dictionary and fix a special line locally. The interface explicitly shows unsupported stress or tempo. Spell out numbers and Latin text for limited voices.
7. Press Build video and follow stages. Fresh clips are reused; stale ones are rerecorded. Watch individual scenes and audio, then the final video. Download MP4 and a separate SRT.
8. Watch the entire film and listen to uncertain passages. Recognition detects omissions and silence but does not verify intonation or stress.

## Result

The card provides the video and subtitles. During rebuilding, the previous file is explicitly marked as previous. Restarting the interface does not lose saved build progress.

## Limitations and recovery

Changing the target, policy or data requires revalidation. Mark external data changes with Data updated; there is no automatic detection. Demo-data preparation requires a trusted recipe on an isolated manual sandbox and confirmation; unknown outcomes are not automatically repeated.

Changing voice/text makes audio stale; changing actions makes recording stale; changing captions makes the final output stale. Your own audio is retained. Git history changes may require refreshing an explicit selection; an old script is not presented as the result of a new selection. Concurrent changes from another window require reloading.

A short recording of a static interface may be small because of compression. Size alone does not mean failure: duration and the presence of picture in frames are checked. Empty, too-short or entirely uniform recordings are still rejected.

Network/key readiness is not a paid trial. If GPU memory is insufficient, close programs using it or choose another voice. Download important final output before the configured retention period expires (default: 30 days without changes). Automatic delivery through channels is not connected yet; use download. The final MP4 is not checked frame by frame.

## Related articles

[Sandboxes](sandboxes.md) · [Speech](speech.md) · [Plugins](plugins.md) · [Troubleshooting](troubleshooting.md)
