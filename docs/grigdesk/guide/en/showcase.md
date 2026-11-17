# Presentations and videos

Turn finished work into a script, narration, interface recordings and MP4 with
separate subtitles. A video can be created before choosing an environment.

## Before you begin

Enable Presentations. Check the recording browser, ffmpeg, storage and script model.
Use a suitable voice or your own audio. Cloud speech and model requests may send
text to providers and incur charges.

## What to do

1. Click New video. The editor opens; creation does not start a build.
2. Choose a permanent project environment or sandbox and click Attach environment.
   Running-attempt and unresponsive-interface warnings are shown before attaching.
   Use Open sandboxes to raise an environment in its own section.
3. Choose a voice and supported pace before analysis. Install Piper or Silero in
   voice settings; Qwen cloud requires a server environment key. Size and license
   are shown before installation. Listen to a sample.
4. Enter an optional B24 task number and a note describing what to show.
   Apply selection saves the source and starts a full run for an empty video.
   Analyze again can prepare the script separately. The model proposes a brief
   and scenes; the server verifies actions on the environment and explains failures.
5. Select scenes in the horizontal timeline. Edit narration, captions and subtitles,
   reorder scenes or delete them. Drafts survive scene selection; Build video saves
   them first. Reshoot scene rerecords its entire continuation chain. A continuation
   keeps dialogs and selected rows from the preceding scene.
6. When changing engines, confirm rewriting narration. Unsaved edits are saved first;
   text adapts to the voice while scenes and actions stay. Manual cue bindings are
   re-linked. Declining preserves input. After failure, use Rewrite narration for voice.
   Scenes with uploaded audio remain untouched.
7. Supported voices use `+` before a stressed vowel. Put common words in the dictionary
   and special pronunciation in a local correction. Silero needs numbers and Latin
   text spelled out; Token Plan stress support is experimental.
8. Click Build video. Current clips are reused. After removing an environment,
   assembly remains available when saved clips and recording journals are current
   and the script source is unchanged. Narration edits regenerate TTS without
   rerecording such clips.
9. Watch and listen to the full result; download MP4 and separate SRT.
   Speech checks can detect silence and missing words, but do not prove intonation or stress.

## Result

The card stores the video, scenes and subtitles. The previous file remains available
while rebuilding and is clearly labelled. Reloading the interface preserves saved build progress.

After text edits, reshooting can first recheck the saved script with the model.
The new shared verification result marks other scenes’ previous clips stale;
the next full build rerecords them. The clips remain available until that build.

## Limits and recovery

A missing address, foreign environment or changed generation requires another explicit choice.
Warnings do not bypass ownership checks or environment leases. Wait for the video's active
work to finish, or cancel it, before changing its environment.

Changing the source requires new analysis. Action, policy or data changes may need new
recording; mark external data changes with Data updated. Text or voice changes stale audio;
caption changes stale final output. Uploaded audio is never resynthesized. Concurrent
edits reload the card while preserving the draft for a human decision.

Network/key readiness does not prove a paid synthesis succeeded. Verify real model
installation and speech quality on your machine. Download important results before retention
expires, normally after 30 days without changes. Automatic channel delivery and
frame-by-frame verification of the final MP4 are not connected yet.

## Related articles

[Sandboxes](sandboxes.md) · [Speech](speech.md) · [Plugins](plugins.md) · [Troubleshooting](troubleshooting.md)
