#!/usr/bin/env bash
# Guard: no provider API key (Anthropic, OpenAI, ElevenLabs, …) may reach the public
# client bundle or be committed to the repo. Runs in CI (evals workflow) and locally:
#   bash scripts/check_secrets.sh
#
# Real secrets live only in .env (gitignored) and Fly secrets. The React client only ever
# holds its own JWT; every model / TTS / STT call is proxied through the authenticated
# backend, so a key never has to touch the browser.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
note() { echo "SECRET-SCAN: $*"; }

# 1) Hardcoded provider key VALUES anywhere in tracked files (skip env/examples/this dir).
if git grep -nIE '(sk-ant-[A-Za-z0-9]{20})|(sk-[A-Za-z0-9]{40})|(AKIA[0-9A-Z]{16})|(xox[baprs]-[0-9A-Za-z-]{10})' \
     -- . ':(exclude).env*' ':(exclude)*.example' ':(exclude)scripts/*' ':(exclude).github/*'; then
  note "hardcoded API key found in a tracked file — move it to .env / Fly secrets"; fail=1
fi

# 2) The client bundle is PUBLIC and Vite inlines any import.meta.env.VITE_* the code reads,
#    so the frontend must never read a secret-looking env var. (This is the real leak
#    vector; merely NAMING a server secret in a comment is harmless — the frontend can't
#    read server env, only VITE_*-prefixed build vars — so we don't flag that.)
if git grep -nIE 'import\.meta\.env\.[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE)' -- frontend; then
  note "frontend reads a secret-looking VITE_ var — it would be bundled into the public client"; fail=1
fi

if [ "$fail" -eq 0 ]; then note "OK — no client-exposed secrets"; fi
exit "$fail"
