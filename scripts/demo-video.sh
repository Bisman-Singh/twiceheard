#!/bin/bash
# Assembles the demonstration video from two recorded calls.
#
# Inputs, all in the directory given as the first argument:
#   call-a-clean.webm / call-a-audio.ogg          a call where every line comes out verified
#   call-b-unanswered.webm / call-b-audio.ogg     a call where the caller never answers one readback
#   line-1.wav, line-4.wav                        narration
#
# Why two calls. One call can only show one outcome, and the product's claim needs both:
# that a good call comes out clean and books the appointment, and that a call where nobody
# confirmed a value says so rather than guessing. Showing only the second makes the product
# look like it flags everything; showing only the first proves nothing.
#
# The flagged call is deliberately one where the caller says nothing at all when the
# medication is read back. An earlier cut used a caller who answered "That's the only one I
# take", which reads as agreement to anyone watching and made the flag look pedantic. An
# example a viewer can argue with is worse than no example.
#
# Each call is cut to its two useful stretches: the conversation, and the chart. The dead
# wait between them, while the recording is heard a second time, is honest on screen and
# unwatchable on video.
#
# The timings belong to these two recordings. Re-record and they move: find the chart with
#   ffmpeg -i call-a-clean.webm -vf "select='gt(scene,0.05)',showinfo" -an -f null -
#
# Usage: scripts/demo-video.sh [dir] [out]
set -euo pipefail

DIR="${1:-demo}"
OUT="${2:-$DIR/twiceheard-demo.mp4}"

for f in "$DIR"/call-{a-clean,b-unanswered}.webm "$DIR"/call-{a,b}-audio.ogg "$DIR"/line-{1,4}.wav; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done

# The opening frame is held while the first line is spoken, so the call begins in silence.
LEAD_IN=11
# Where the call's own audio starts inside each recording.
CALL_STARTS_AT=4

# Call A: the conversation from the top, then the chart it produced.
A_TALK_TO=50
A_CHART_FROM=222.3
A_CHART_TO=247

# Call B: the stretch around the medication readback nobody answered, then its chart.
B_TALK_FROM=110
B_TALK_TO=138
B_CHART_FROM=216.2
B_CHART_TO=244

# Parenthesised on purpose. Without the brackets `ms "$LEAD_IN + $CALL_STARTS_AT"`
# evaluates as 11 + 4*1000 and lays the whole call underneath the opening narration,
# which is the overlap this edit exists to avoid and which no amount of reading the
# command catches. Listen to the first fifteen seconds of anything this produces.
ms() { python3 -c "print(int(($1) * 1000))"; }

A_TALK_LEN=$(python3 -c "print($A_TALK_TO - $CALL_STARTS_AT)")
A_CHART_LEN=$(python3 -c "print($A_CHART_TO - $A_CHART_FROM)")
B_TALK_LEN=$(python3 -c "print($B_TALK_TO - $B_TALK_FROM)")

# Where each piece lands on the finished timeline.
S1_AT=$LEAD_IN
S2_AT=$(python3 -c "print($LEAD_IN + $A_TALK_TO)")
S3_AT=$(python3 -c "print($S2_AT + $A_CHART_LEN)")
S4_AT=$(python3 -c "print($S3_AT + $B_TALK_LEN)")

# In milliseconds. ffmpeg accepts a seconds suffix on adelay in principle and ignores it in
# practice, which put a whole call underneath the opening narration and was only caught by
# listening. Milliseconds are what this filter honours.
OPENING_MS=800
A_AUDIO_MS=$(ms "$LEAD_IN + $CALL_STARTS_AT")
B_AUDIO_MS=$(ms "$S3_AT")
SECOND_HEARING_MS=$(ms "$S2_AT + 1.2")

ffmpeg -hide_banner -loglevel error -y \
  -i "$DIR/call-a-clean.webm" -i "$DIR/call-b-unanswered.webm" \
  -i "$DIR/call-a-audio.ogg" -i "$DIR/call-b-audio.ogg" \
  -i "$DIR/line-1.wav" -i "$DIR/line-4.wav" \
  -filter_complex "
    [0:v]trim=0:${A_TALK_TO},setpts=PTS-STARTPTS,
         tpad=start_mode=clone:start_duration=${LEAD_IN}[v1];
    [0:v]trim=${A_CHART_FROM}:${A_CHART_TO},setpts=PTS-STARTPTS[v2];
    [1:v]trim=${B_TALK_FROM}:${B_TALK_TO},setpts=PTS-STARTPTS[v3];
    [1:v]trim=${B_CHART_FROM}:${B_CHART_TO},setpts=PTS-STARTPTS[v4];
    [v1][v2][v3][v4]concat=n=4:v=1:a=0[vout];
    [2:a]atrim=0:${A_TALK_LEN},asetpts=PTS-STARTPTS,
         adelay=${A_AUDIO_MS}|${A_AUDIO_MS},volume=0.95[beda];
    [3:a]atrim=$(python3 -c "print($B_TALK_FROM - $CALL_STARTS_AT)"):$(python3 -c "print($B_TALK_TO - $CALL_STARTS_AT)"),
         asetpts=PTS-STARTPTS,adelay=${B_AUDIO_MS}|${B_AUDIO_MS},volume=0.95[bedb];
    [4:a]adelay=${OPENING_MS}|${OPENING_MS}[l1];
    [5:a]adelay=${SECOND_HEARING_MS}|${SECOND_HEARING_MS}[l4];
    [beda][bedb][l1][l4]amix=inputs=4:normalize=0:duration=longest,
         alimiter=limit=0.95[aout]
  " \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 192k \
  "$OUT"

echo "$OUT"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
