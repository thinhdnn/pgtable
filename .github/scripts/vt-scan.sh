#!/usr/bin/env bash
# Upload release artifacts to VirusTotal and collect their verdicts.
#
# Emits a markdown table on stdout (captured into the release body) and writes
# the worst detection count to $GITHUB_OUTPUT as `max_malicious`.
#
# NOTE: uploads via the free public API are PUBLIC. Do not use on private builds.
set -euo pipefail

: "${VT_API_KEY:?VT_API_KEY is required}"

API="https://www.virustotal.com/api/v3"
# Public API allows 4 requests/minute. Keep polls well clear of that ceiling.
POLL_INTERVAL="${VT_POLL_INTERVAL:-20}"
POLL_MAX="${VT_POLL_MAX:-45}" # 45 * 20s = 15 min ceiling per artifact
DIRECT_UPLOAD_LIMIT=$((32 * 1024 * 1024))

vt() { curl -sS --fail-with-body -H "x-apikey: ${VT_API_KEY}" "$@"; }

max_malicious=0
rows=""

for file in "$@"; do
  name=$(basename "$file")
  size=$(wc -c <"$file" | tr -d ' ')
  sha256=$(sha256sum "$file" | cut -d' ' -f1)
  echo "::group::VirusTotal: ${name} ($((size / 1048576)) MB)" >&2

  # Files over 32MB must go through a one-shot signed upload URL.
  if [[ "$size" -gt "$DIRECT_UPLOAD_LIMIT" ]]; then
    endpoint=$(vt "${API}/files/upload_url" | jq -r '.data')
  else
    endpoint="${API}/files"
  fi

  analysis_id=$(vt -X POST "$endpoint" -F "file=@${file}" | jq -r '.data.id')
  echo "analysis: ${analysis_id}" >&2

  status=""
  for ((i = 0; i < POLL_MAX; i++)); do
    sleep "$POLL_INTERVAL"
    body=$(vt "${API}/analyses/${analysis_id}")
    status=$(jq -r '.data.attributes.status' <<<"$body")
    echo "  poll $((i + 1)): ${status}" >&2
    [[ "$status" == "completed" ]] && break
  done

  if [[ "$status" != "completed" ]]; then
    echo "::warning::${name} did not finish scanning within the timeout" >&2
    rows+="| \`${name}\` | timed out | [link](https://www.virustotal.com/gui/file/${sha256}) |"$'\n'
    echo "::endgroup::" >&2
    continue
  fi

  malicious=$(jq -r '.data.attributes.stats.malicious' <<<"$body")
  suspicious=$(jq -r '.data.attributes.stats.suspicious' <<<"$body")
  undetected=$(jq -r '.data.attributes.stats.undetected' <<<"$body")
  total=$((malicious + suspicious + undetected))

  [[ "$malicious" -gt "$max_malicious" ]] && max_malicious="$malicious"

  rows+="| \`${name}\` | ${malicious} / ${total} | [link](https://www.virustotal.com/gui/file/${sha256}) |"$'\n'
  echo "::endgroup::" >&2
done

{
  echo "## VirusTotal"
  echo
  echo "| Artifact | Detections | Report |"
  echo "| --- | --- | --- |"
  printf '%s' "$rows"
  echo
  echo "_Builds are unsigned, so a small number of heuristic detections is expected._"
} >vt-report.md

echo "max_malicious=${max_malicious}" >>"${GITHUB_OUTPUT:-/dev/stdout}"
cat vt-report.md
