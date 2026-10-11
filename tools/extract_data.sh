#!/bin/sh
#
# tools/extract_data.sh <report.html> -- dev helper: copy the D.* datasets
# out of a generated report into web/dev-data.js, so web/dev.html can run
# web/app.js and web/style.css straight from source (edit, reload).
#
set -eu
cd "$(dirname "$0")/.."
src=${1:?usage: tools/extract_data.sh reports/<file>.html}
awk '
    /^<script>var D = \{\};<\/script>$/ { on = 1; print "var D = {};"; next }
    on && /^<script>$/ { exit }
    on { print }
' "$src" | sed 's#^<script>##; s#</script>$##' > web/dev-data.js
echo "web/dev-data.js: $(wc -c < web/dev-data.js) bytes"
