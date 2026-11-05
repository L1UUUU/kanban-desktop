#!/usr/bin/env bash
# 用途：安装指定版本 @anthropic-ai/claude-agent-sdk 并在 Windows 跑一次三段复测（check.mjs），供重复验证
set -euo pipefail
ver="${1:?usage: bash run.sh <sdk-version>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
npm install --no-audit --no-fund "@anthropic-ai/claude-agent-sdk@${ver}" >/dev/null
node check.mjs
