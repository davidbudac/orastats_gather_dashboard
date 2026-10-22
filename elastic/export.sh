#!/usr/bin/env bash
# elastic/export.sh -- run on the DB host as the Oracle owner: export
# statistics-gathering history as NDJSON for Filebeat, which ships it to
# Logstash, which indexes it as orastats-gather-<record>. Nothing here talks
# to Elasticsearch, and nothing runs against the database except SELECTs.
#
#   elastic/export.sh --sid cdb1                 # CDB$ROOT: every container
#   elastic/export.sh --sid cdb1 --days 31       # first load: the whole history
#   elastic/export.sh --sid cdb1 --container PDB1
#
# Options: --sid SID  --container PDB
#          --days N         (operations, tasks and windows started in the last
#                            N days; default 2, enough for a daily run)
#          --source LABEL   (default the SID; keys every document id, keep it
#                            stable per database)
#          --out DIR        (default /u01/app/oracle/filebeat/generated, the
#                            directory elastic/filebeat/orastats-gather.yml tails)
#          --retention-days N  (delete orastats-gather-*.ndjson older than N
#                            days, default 7)
#          --stdout         (print the validated NDJSON instead of writing a file)
# Every document has a deterministic id, so overlapping runs overwrite instead
# of duplicating. Needs bash, python3 and sqlplus (after oraenv; ORACLE_SID is
# enough).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
sid="" container="" source_label="" to_stdout="" days=2
out_dir=/u01/app/oracle/filebeat/generated
retention_days=7

die() { echo "export.sh: $*" >&2; exit 1; }
while (($#)); do
    case $1 in
        --stdout) to_stdout=1; shift; continue ;;
    esac
    [[ $# -ge 2 ]] || die "missing value for $1"
    case $1 in
        --sid)            sid=$2 ;;
        --container)      container=$2 ;;
        --days)           days=$2 ;;
        --source)         source_label=$2 ;;
        --out)            out_dir=$2 ;;
        --retention-days) retention_days=$2 ;;
        *) die "unknown option $1" ;;
    esac
    shift 2
done
source_label=${source_label:-${sid:-${ORACLE_SID:-local}}${container:+/$container}}
[[ $source_label =~ ^[A-Za-z0-9_./:-]+$ ]] || die "--source may hold letters, digits and _ . / : - only"
[[ $days =~ ^[0-9]+$ && $days -ge 1 ]] || die "--days must be a positive integer"
[[ $retention_days =~ ^[0-9]+$ ]] || die "--retention-days must be an integer"

oracle_env=""
# cron starts with PATH=/usr/bin:/bin; oraenv lives in /usr/local/bin
export PATH="$PATH:/usr/local/bin"
if [[ -n $sid ]]; then
    oracle_env="export ORACLE_SID=$sid; export ORAENV_ASK=NO; . oraenv >/dev/null 2>&1; "
fi

sql_script() {
    echo "WHENEVER SQLERROR EXIT FAILURE"
    echo "WHENEVER OSERROR EXIT FAILURE"
    [[ -n $container ]] && echo "ALTER SESSION SET CONTAINER = $container;"
    echo "DEFINE gs_days = $days"
    echo "DEFINE gs_source = $source_label"
    cat "$here/export_gather.sql"
    echo
    echo "EXIT"
}

raw=$(mktemp -t orastats-gather.XXXXXX)
trap 'rm -f "$raw"' EXIT
sql_script | bash -c "${oracle_env}NLS_LANG=AMERICAN_AMERICA.AL32UTF8 sqlplus -S -L / as sysdba" > "$raw" \
    || { cat "$raw" >&2; die "export failed"; }

# Validate every line against the mapping before Filebeat sees it: a document
# with an unmapped field is otherwise rejected far downstream, where only the
# Logstash log would show it.
TEMPLATE="$here/elasticsearch/index-template.json" python3 - "$raw" <<'PY'
import collections, json, os, re, sys

path = sys.argv[1]
mappings = json.load(open(os.environ["TEMPLATE"]))["template"]["mappings"]
STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z")
RECORDS = {"operation", "task", "stale", "window", "status"}


def fail(msg):
    sys.exit(f"export.sh: {msg}")


def leaf_paths(props, prefix=""):
    for name, spec in props.items():
        if "properties" in spec:
            yield from leaf_paths(spec["properties"], f"{prefix}{name}.")
        else:
            yield prefix + name


def doc_paths(obj, prefix=""):
    for k, v in obj.items():
        if isinstance(v, dict):
            yield from doc_paths(v, f"{prefix}{k}.")
        else:
            yield prefix + k


allowed = set(leaf_paths(mappings["properties"])) | {"id"}
ids = collections.Counter()
counts = collections.Counter()
with open(path, encoding="utf-8") as fh:
    for n, line in enumerate(fh, 1):
        line = line.strip()
        if not line:
            continue
        if not line.startswith("{"):
            fail(f"line {n} is not a JSON document (SQL*Plus error?): {line}")
        try:
            doc = json.loads(line)
        except json.JSONDecodeError as e:
            fail(f"line {n} is not valid JSON ({e}): {line[:300]}")
        rec = doc.get("gs", {}).get("record")
        if not doc.get("id") or "@timestamp" not in doc or rec not in RECORDS:
            fail(f"line {n} lacks id/@timestamp/gs.record: {line[:300]}")
        if not STAMP.fullmatch(doc["@timestamp"]):
            fail(f"line {n} @timestamp is not an ISO UTC instant: {line[:300]}")
        unknown = set(doc_paths(doc)) - allowed
        if unknown:
            fail(f"line {n} has fields not in the index template {sorted(unknown)}: {line[:300]}")
        ids[doc["id"]] += 1
        counts[rec] += 1
if not ids:
    fail("the export produced no documents")
dupes = [i for i, c in ids.items() if c > 1]
if dupes:
    fail(f"{len(dupes)} duplicate ids, e.g. {dupes[0]}")
for rec, c in sorted(counts.items()):
    print(f"{rec:10} {c:7}", file=sys.stderr)
print(f"{sum(ids.values())} documents validated", file=sys.stderr)
PY

if [[ -n $to_stdout ]]; then
    grep '^{' "$raw"
    exit 0
fi

mkdir -p "$out_dir"
slug=$(printf '%s' "$source_label" | tr -c 'A-Za-z0-9' '_')
out="$out_dir/orastats-gather-${slug}-$(date -u +%Y%m%d).ndjson"
grep '^{' "$raw" >> "$out"
chmod 600 "$out"
find "$out_dir" -name 'orastats-gather-*.ndjson' -type f -mtime "+$retention_days" -delete
echo "appended to $out"
