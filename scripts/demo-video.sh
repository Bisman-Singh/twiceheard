#!/bin/bash
# Assembles the demonstration video from the pieces the other scripts produce.
#
# Inputs, all in the directory given as the first argument:
#   twiceheard-call.webm   the screen recording of one real browser call (silent)
#   call-audio.ogg         that same call's audio, from the platform's session history
#   line-1.wav .. line-6.wav   the narration, one file per line
#
# The recording has about twenty seconds of dead air between the call ending and the
# chart appearing, which is honest on screen and unwatchable on video, so that stretch
# is cut and the final chart is held instead. The call's own audio carries the middle
# and ducks under each line of narration.
#
# Usage: scripts/demo-video.sh [dir] [out]
set -euo pipefail

DIR="${1:-demo}"
OUT="${2:-$DIR/twiceheard-demo.mp4}"

VIDEO="$DIR/twiceheard-call.webm"
BED="$DIR/call-audio.ogg"

for f in "$VIDEO" "$BED" "$DIR"/line-{1,2,3,4,5,6}.wav; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done

# Where the call starts in the recording, and where the dead wait begins and ends.
CALL_STARTS_AT=3
CUT_FROM=172
CUT_TO=192
HOLD_LAST_FRAME=14

# Each narration line's position on the finished timeline, in seconds.
AT=(1 12 60 166 174 181)

ffmpeg -hide_banner -loglevel error -y \
  -i "$VIDEO" -i "$BED" \
  -i "$DIR/line-1.wav" -i "$DIR/line-2.wav" -i "$DIR/line-3.wav" \
  -i "$DIR/line-4.wav" -i "$DIR/line-5.wav" -i "$DIR/line-6.wav" \
  -filter_complex "
    [0:v]trim=0:${CUT_FROM},setpts=PTS-STARTPTS[v1];
    [0:v]trim=${CUT_TO},setpts=PTS-STARTPTS[v2];
    [v1][v2]concat=n=2:v=1:a=0[vc];
    [vc]tpad=stop_mode=clone:stop_duration=${HOLD_LAST_FRAME}[vout];
    [1:a]adelay=${CALL_STARTS_AT}000|${CALL_STARTS_AT}000,volume=0.85,
         volume=volume=0.30:enable='between(t,${AT[0]},11.3)+between(t,11.9,15.3)+between(t,59.8,66.2)'[bed];
    [2:a]adelay=${AT[0]}000|${AT[0]}000[l1];
    [3:a]adelay=${AT[1]}000|${AT[1]}000[l2];
    [4:a]adelay=${AT[2]}000|${AT[2]}000[l3];
    [5:a]adelay=${AT[3]}000|${AT[3]}000[l4];
    [6:a]adelay=${AT[4]}000|${AT[4]}000[l5];
    [7:a]adelay=${AT[5]}000|${AT[5]}000[l6];
    [bed][l1][l2][l3][l4][l5][l6]amix=inputs=7:normalize=0:duration=longest,
         alimiter=limit=0.95[aout]
  " \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 192k \
  "$OUT"

echo "$OUT"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
