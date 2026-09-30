#!/bin/bash
# Assembles the demonstration video from one whole call.
#
# Inputs, all in the directory given as the first argument:
#   call.webm / call-audio.ogg    one recorded call, and its audio from the platform
#   line-*.wav                    narration, one clip per thing being explained
#
# The whole call is shown, start to finish, because the submission is judged on showing
# the product working and a cut conversation shows less than an uncut one. What is cut is
# the stretch after the call ends while the recording is heard again, which is honest on
# screen and unwatchable on video.
#
# The narration never talks over anyone. Each line is placed in a measured gap in the
# call's own audio and is shorter than that gap. Find the gaps with
#   ffmpeg -i call-audio.ogg -af silencedetect=noise=-36dB:d=1.2 -f null -
# and the chart with
#   ffmpeg -i call.webm -vf "select='gt(scene,0.05)',showinfo" -an -f null -
# Both were measured for this recording; re-record and they all move.
#
# Usage: scripts/demo-video.sh [dir] [out]
set -euo pipefail

DIR="${1:-demo}"
OUT="${2:-$DIR/twiceheard-demo.mp4}"

for f in "$DIR"/call.webm "$DIR"/call-audio.ogg \
         "$DIR"/line-{open,readback,slip,digits,drug,allergies,slots,second,chart,close}.wav; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done

# The opening frame is held while the first line is spoken, so the call begins in silence.
LEAD_IN=15
# Where the call's own audio starts inside the recording.
CALL_STARTS_AT=4
# The call, from the page at rest to a few seconds after it ends.
CALL_TO=203
# The chart, after the wait while the recording is heard a second time.
CHART_FROM=222.3
CHART_TO=250.3

# Parenthesised on purpose. Without the brackets `ms "$LEAD_IN + $CALL_STARTS_AT"` evaluates
# as 15 + 4*1000 and lays the whole call underneath the opening narration, which is the
# overlap this edit exists to avoid and which reading the command does not catch. Listen to
# the first twenty seconds of anything this produces.
ms() { python3 -c "print(int(($1) * 1000))"; }

CHART_LEN=$(python3 -c "print($CHART_TO - $CHART_FROM)")
CHART_AT=$(python3 -c "print($LEAD_IN + $CALL_TO)")

# A narration line goes at a point in the call's own audio, so it is placed relative to that.
at() { ms "$LEAD_IN + $CALL_STARTS_AT + $1"; }

OPEN_MS=800
READBACK_MS=$(at 30.1)      # after the first readback, before the caller answers
SLIP_MS=$(at 42.4)          # while the agent asks for the date of birth
DIGITS_MS=$(at 71.6)        # while the agent asks for a phone number
DRUG_MS=$(at 102.2)         # while the agent asks about medications
ALLERGIES_MS=$(at 130.3)    # while the agent asks about allergies
SLOTS_MS=$(at 145.9)        # after the allergies readback
SECOND_MS=$(ms "$CHART_AT - 6")     # as the call ends and the page says it is listening again
CHART_MS=$(ms "$CHART_AT + 2.2")    # as the chart arrives
CLOSE_MS=$(ms "$CHART_AT + 12")     # on the one rule the whole thing rests on

ffmpeg -hide_banner -loglevel error -y \
  -i "$DIR/call.webm" -i "$DIR/call-audio.ogg" \
  -i "$DIR/line-open.wav" -i "$DIR/line-readback.wav" -i "$DIR/line-slip.wav" \
  -i "$DIR/line-digits.wav" -i "$DIR/line-drug.wav" -i "$DIR/line-allergies.wav" \
  -i "$DIR/line-slots.wav" -i "$DIR/line-second.wav" -i "$DIR/line-chart.wav" \
  -i "$DIR/line-close.wav" \
  -filter_complex "
    [0:v]trim=0:${CALL_TO},setpts=PTS-STARTPTS,
         tpad=start_mode=clone:start_duration=${LEAD_IN}[v1];
    [0:v]trim=${CHART_FROM}:${CHART_TO},setpts=PTS-STARTPTS[v2];
    [v1][v2]concat=n=2:v=1:a=0[vout];
    [1:a]adelay=$(ms "$LEAD_IN + $CALL_STARTS_AT")|$(ms "$LEAD_IN + $CALL_STARTS_AT"),volume=0.95[bed];
    [2:a]adelay=${OPEN_MS}|${OPEN_MS}[l1];
    [3:a]adelay=${READBACK_MS}|${READBACK_MS}[l2];
    [4:a]adelay=${SLIP_MS}|${SLIP_MS}[l3];
    [5:a]adelay=${DIGITS_MS}|${DIGITS_MS}[l4];
    [6:a]adelay=${DRUG_MS}|${DRUG_MS}[l5];
    [7:a]adelay=${ALLERGIES_MS}|${ALLERGIES_MS}[l6];
    [8:a]adelay=${SLOTS_MS}|${SLOTS_MS}[l7];
    [9:a]adelay=${SECOND_MS}|${SECOND_MS}[l8];
    [10:a]adelay=${CHART_MS}|${CHART_MS}[l9];
    [11:a]adelay=${CLOSE_MS}|${CLOSE_MS}[l10];
    [bed][l1][l2][l3][l4][l5][l6][l7][l8][l9][l10]amix=inputs=11:normalize=0:duration=longest,
         alimiter=limit=0.95[aout]
  " \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 192k \
  "$OUT"

echo "$OUT"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
