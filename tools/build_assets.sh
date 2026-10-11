#!/bin/sh
#
# tools/build_assets.sh -- turn the readable page sources into the SQL*Plus
# scripts that print them into the report:
#
#   web/style.css -> sql/_css.sql   (wrapped in <style>)
#   web/app.js    -> sql/_app.sql   (wrapped in <script>)
#
# Usage:
#   tools/build_assets.sh           regenerate both
#   tools/build_assets.sh --check   exit 1 if a committed sql/_*.sql is stale
#
# Dev-time only; the generated files are committed so a report run needs
# nothing but SQL*Plus.  Every source line becomes
#   DBMS_OUTPUT.PUT_LINE(q'~<line>~');
# in PL/SQL blocks of at most 250 lines.  Rules (each would break a run):
#   - no "~'" in a source line (it would end the q-quote)
#   - no line of 2400 characters or more (SQL*Plus rejects input lines
#     past 2499 characters)
#   - ASCII only: SQL*Plus re-encodes to the client NLS_LANG character
#     set and turns anything else into "?" (write \u2192 in JS instead)
#
set -u
cd "$(dirname "$0")/.." || exit 2
export LC_ALL=C

gen() {   # src open_tag close_tag
    awk -v src="$1" -v open="$2" -v closetag="$3" '
    BEGIN {
        print "--"
        print "-- GENERATED from " src " by tools/build_assets.sh -- do not edit."
        print "--"
        print ""
        print "SET DEFINE OFF"
        print "BEGIN"
        print "DBMS_OUTPUT.PUT_LINE(q'"'"'~" open "~'"'"');"
        n = 1
    }
    {
        if (index($0, "~'"'"'") > 0) { printf "%s:%d: contains ~'"'"'\n", src, NR > "/dev/stderr"; bad = 1 }
        if (length($0) >= 2400)       { printf "%s:%d: line too long\n", src, NR > "/dev/stderr"; bad = 1 }
        if ($0 ~ /[^\001-\177]/)     { printf "%s:%d: non-ASCII character\n", src, NR > "/dev/stderr"; bad = 1 }
        if ($0 ~ /^[ \t]*$/) next
        if (n >= 250) { print "END;"; print "/"; print "BEGIN"; n = 0 }
        print "DBMS_OUTPUT.PUT_LINE(q'"'"'~" $0 "~'"'"');"
        n++
    }
    END {
        print "DBMS_OUTPUT.PUT_LINE(q'"'"'~" closetag "~'"'"');"
        print "END;"
        print "/"
        print "SET DEFINE ON"
        exit bad
    }' "$1"
}

check=0
[ "${1:-}" = "--check" ] && check=1
rc=0
for pair in "web/style.css:sql/_css.sql:<style>:</style>" "web/app.js:sql/_app.sql:<script>:</script>"; do
    src=${pair%%:*}; rest=${pair#*:}
    dst=${rest%%:*}; rest=${rest#*:}
    open=${rest%%:*}; close=${rest#*:}
    tmp=$(mktemp) || exit 2
    gen "$src" "$open" "$close" > "$tmp" || { rm -f "$tmp"; exit 1; }
    if [ $check = 1 ]; then
        cmp -s "$tmp" "$dst" || { echo "stale: $dst (run tools/build_assets.sh)"; rc=1; }
        rm -f "$tmp"
    else
        mv "$tmp" "$dst"
    fi
done
exit $rc
