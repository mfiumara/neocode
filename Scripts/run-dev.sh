#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
"$repository_root/Scripts/build-app.sh" debug
/usr/bin/open "$repository_root/.build/app/Orchestrator.app"
