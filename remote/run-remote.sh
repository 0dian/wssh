#!/bin/sh
# Entry point invoked over `ssh -T`. Deliberately free of hardcoded user names or
# install paths: everything is resolved from this script's own location, so the
# same bundle works under any Windows account.
#
#   run-remote.sh <cols> <rows> [cmd [args...]]
#
# With no cmd it starts an interactive login shell inside the new ConPTY, which
# is the normal entry point: the user then launches herdr (or anything else)
# from that shell with mouse support already in place.

MSYS2_ARG_CONV_EXCL="*"
export MSYS2_ARG_CONV_EXCL

# Git Bash reports POSIX paths ("/c/Users/x"), which Node on Windows cannot
# resolve. `pwd -W` gives the native form ("C:/Users/x"); plain `pwd` is the
# fallback for a non-MSYS sh.
DIR=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })

COLS="$1"; [ -n "$COLS" ] || COLS=120
ROWS="$2"; [ -n "$ROWS" ] || ROWS=40
[ $# -ge 1 ] && shift
[ $# -ge 1 ] && shift

if [ $# -eq 0 ]; then
  # Default: interactive login shell. -l so it reads the profile and gets the
  # full Git Bash PATH — `ssh -T` gave us a non-login, non-interactive env.
  SH=${WSSH_SHELL:-$SHELL}
  [ -n "$SH" ] || SH=bash
  set -- "$SH" -l -i
fi

CMD="$1"; shift

# A bare name has to become a native absolute path before it reaches ConPTY:
# CreateProcess does not search the MSYS PATH, and it will not append ".exe" to
# a name we hand it explicitly.
case "$CMD" in
  */* | *\\*)
    # $SHELL and friends are POSIX paths too — convert those as well.
    NATIVE=$(cygpath -m "$CMD" 2>/dev/null) || NATIVE=""
    [ -n "$NATIVE" ] && CMD="$NATIVE"
    ;;
  *)
    RESOLVED=$(command -v "$CMD" 2>/dev/null) || RESOLVED=""
    if [ -n "$RESOLVED" ]; then
      NATIVE=$(cygpath -m "$RESOLVED" 2>/dev/null) || NATIVE=""
      [ -n "$NATIVE" ] && CMD="$NATIVE"
    fi
    ;;
esac
case "$CMD" in
  *.exe | *.cmd | *.bat | *.com) ;;
  *) [ -f "$CMD.exe" ] && CMD="$CMD.exe" ;;
esac

NODE=${WSSH_NODE:-node}

exec "$NODE" "$DIR/relay.js" "$COLS" "$ROWS" "$CMD" "$@"
