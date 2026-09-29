#!/bin/bash
# Assembles the demonstration video from the pieces the other scripts produce.
#
# Inputs, all in the directory given as the first argument:
#   twiceheard-call.webm   the screen recording of one real browser call (silent)
#   call-audio.ogg         that same call's audio, from the platform's session history
#   line-1.wav .. line-6.wav   the narration, one file per line
#
# Two rules decide the edit. The call's own audio never has a gap longer than about six
# seconds, so narration is never laid over it: it plays before the call starts and after
# it ends, and the conversation carries the middle on its own. And the recording has
# about twenty seconds of dead air between the call ending and the chart appearing, which
# is honest on screen and unwatchable on video, so that stretch is cut.
#
# Lines 2, 3 and 5 of the narration are deliberately unused. They were written to sit over
# the conversation, and they talked across it.
#
# Usage: scripts/demo-video.sh [dir] [out]
set -euo pipefail

DIR="${1:-demo}"
OUT="${2:-$DIR/twiceheard-demo.mp4}"

VIDEO="$DIR/twiceheard-call.webm"
BED="$DIR/call-audio.ogg"

for f in "$VIDEO" "$BED" "$DIR"/line-{1,4,6}.wav; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done

# The opening frame is held while the first line is spoken, so the call begins in silence.
LEAD_IN=11.5
# Where the call starts inside the recording, and the dead wait to cut out of it.
CALL_STARTS_AT=3
CUT_FROM=172
CUT_TO=186
TAIL_END=222

# Each narration line's position on the finished timeline, in seconds.
# In milliseconds. ffmpeg accepts a seconds suffix here in principle and ignores it in
# practice, which put the whole call underneath the opening narration and was only caught
# by listening. Milliseconds are what this filter actually honours.
OPENING_MS=800
AFTER_CALL_MS=179500
ON_THE_CHART_MS=206000
BED_AT_MS=$(python3 -c "print(int((${LEAD_IN} + ${CALL_STARTS_AT}) * 1000))")

ffmpeg -hide_banner -loglevel error -y \
  -i "$VIDEO" -i "$BED" \
  -i "$DIR/line-1.wav" -i "$DIR/line-4.wav" -i "$DIR/line-6.wav" \
  -filter_complex "
    [0:v]trim=0:${CUT_FROM},setpts=PTS-STARTPTS,
         tpad=start_mode=clone:start_duration=${LEAD_IN}[v1];
    [0:v]trim=${CUT_TO}:${TAIL_END},setpts=PTS-STARTPTS[v2];
    [v1][v2]concat=n=2:v=1:a=0[vout];
    [1:a]adelay=${BED_AT_MS}|${BED_AT_MS},volume=0.95[bed];
    [2:a]adelay=${OPENING_MS}|${OPENING_MS}[l1];
    [3:a]adelay=${AFTER_CALL_MS}|${AFTER_CALL_MS}[l4];
    [4:a]adelay=${ON_THE_CHART_MS}|${ON_THE_CHART_MS}[l6];
    [bed][l1][l4][l6]amix=inputs=4:normalize=0:duration=longest,
         alimiter=limit=0.95[aout]
  " \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 192k \
  "$OUT"

echo "$OUT"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
