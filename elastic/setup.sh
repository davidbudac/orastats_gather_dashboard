#!/usr/bin/env bash
# elastic/setup.sh -- stack-side setup, run from a workstation that reaches
# Elasticsearch and Kibana: the orastats-gather index template (plus an
# additive mapping update on indices that already exist), then the Kibana
# data view and the three dashboards. Idempotent: PUTs and overwrite=true
# imports with fixed ids. Shipping itself never needs these credentials.
#
#   ES_URL, ES_USER, ES_PASSWORD             default http://localhost:9200, elastic
#   KIBANA_URL, KIBANA_USER, KIBANA_PASSWORD default http://localhost:5601, elastic
#
#   elastic/setup.sh
set -euo pipefail

ES_URL="${ES_URL:-http://localhost:9200}"
ES_USER="${ES_USER:-elastic}"
ES_PASSWORD="${ES_PASSWORD:-changeme}"
KIBANA_URL="${KIBANA_URL:-http://localhost:5601}"
KIBANA_USER="${KIBANA_USER:-elastic}"
KIBANA_PASSWORD="${KIBANA_PASSWORD:-changeme}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template=orastats-gather

es() {
  local method="$1" path="$2" body="$3" out
  out="$(curl -sS -u "$ES_USER:$ES_PASSWORD" -H 'Content-Type: application/json' \
    -X "$method" "$ES_URL$path" --data-binary "$body")"
  if ! grep -q '"acknowledged":true' <<<"$out"; then
    echo "$method $path failed: $out" >&2
    exit 1
  fi
}

es PUT "/_index_template/$template" "@$here/elasticsearch/index-template.json"
for rec in operation task stale window status; do
  index="$template-$rec"
  if [[ $(curl -sS -o /dev/null -w '%{http_code}' -u "$ES_USER:$ES_PASSWORD" "$ES_URL/$index") == 200 ]]; then
    es PUT "/$index/_mapping" "$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["template"]["mappings"]))' "$here/elasticsearch/index-template.json")"
  fi
done
echo "index template $template applied"

python3 "$here/kibana/build_dashboards.py"

import() {
  local file="$1" out
  out="$(curl -sS -u "$KIBANA_USER:$KIBANA_PASSWORD" -H 'kbn-xsrf: true' \
    -X POST "$KIBANA_URL/api/saved_objects/_import?overwrite=true" \
    -F "file=@$file")"
  if ! grep -q '"success":true' <<<"$out"; then
    echo "import failed: $file" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "imported $(basename "$file")"
}

import "$here/kibana/data-views.ndjson"
for f in "$here"/kibana/dashboards/*.ndjson; do
  import "$f"
done

for id in orastats-gather-overview orastats-gather-run orastats-gather-stale; do
  echo "$KIBANA_URL/app/dashboards#/view/$id"
done
