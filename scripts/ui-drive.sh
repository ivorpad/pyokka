#!/bin/zsh
# Sequence runner. Each arg group: key:NAME | hot:cmd,shift,p | type:TEXT | cap:NAME | click:X,Y | move:X,Y | sleep:SECS
# Screenshots go to $PYOKKA_SHOTS, or $TMPDIR/pyokka-shots. Needs cua-driver and macOS screencapture.
S=${PYOKKA_SHOTS:-${TMPDIR:-/tmp}/pyokka-shots}
mkdir -p "$S"
D='{"session":"pyokka-fg","scope":"desktop"'
for step in "$@"; do
  op=${step%%:*}; arg=${step#*:}
  case $op in
    key)   cua-driver press_key "$D,\"key\":\"$arg\"}" >/dev/null 2>&1; sleep 0.5;;
    hot)   keys=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1].split(",")))' "$arg"); cua-driver hotkey "$D,\"keys\":$keys}" >/dev/null 2>&1; sleep 0.8;;
    type)  cua-driver type_text "$D,\"text\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$arg")}" >/dev/null 2>&1; sleep 1;;
    cap)   screencapture -l${WIN:-151} -x -o "$S/$arg.png";;
    rcap)  n=${arg%%,*}; r=${arg#*,}; screencapture -x -R "$r" -o "$S/$n.png";;
    click) cua-driver click "$D,\"x\":${arg%%,*},\"y\":${arg#*,}}" >/dev/null 2>&1; sleep 1.2;;
    cmdclick) cua-driver click "$D,\"x\":${arg%%,*},\"y\":${arg#*,},\"modifier\":[\"cmd\"]}" >/dev/null 2>&1; sleep 1.2;;
    shiftclick) cua-driver click "$D,\"x\":${arg%%,*},\"y\":${arg#*,},\"modifier\":[\"shift\"]}" >/dev/null 2>&1; sleep 1.2;;
    move)  cua-driver move_cursor "$D,\"x\":${arg%%,*},\"y\":${arg#*,}}" >/dev/null 2>&1; sleep 0.3;;
    sleep) sleep $arg;;
  esac
done
echo ok
