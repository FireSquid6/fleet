#!/usr/bin/env bash
# Installs all fleet CLIs to ~/.local/bin.
set -euo pipefail
cd "$(dirname "$0")"
bash apps/cli/local-install.sh
bash apps/fagent/local-install.sh
