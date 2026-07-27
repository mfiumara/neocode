#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
configuration=${1:-debug}

if [[ "$configuration" != "debug" && "$configuration" != "release" ]]; then
  print -u2 "usage: Scripts/build-app.sh [debug|release]"
  exit 64
fi

cd "$repository_root"
swift build --configuration "$configuration"
binary_directory=$(swift build --configuration "$configuration" --show-bin-path)
output_directory="$repository_root/.build/app"
app_bundle="$output_directory/Orchestrator.app"

if [[ "$app_bundle" != "$repository_root/.build/app/Orchestrator.app" ]]; then
  print -u2 "refusing to replace unexpected bundle path: $app_bundle"
  exit 70
fi

/bin/rm -rf "$app_bundle"
/usr/bin/install -d \
  "$app_bundle/Contents/MacOS" \
  "$app_bundle/Contents/Helpers" \
  "$app_bundle/Contents/Library/LaunchAgents" \
  "$app_bundle/Contents/Resources"

/usr/bin/install -m 755 "$binary_directory/Orchestrator" \
  "$app_bundle/Contents/MacOS/Orchestrator"
/usr/bin/install -m 755 "$binary_directory/OrchestratorService" \
  "$app_bundle/Contents/Helpers/OrchestratorService"
/usr/bin/install -m 755 "$binary_directory/OrchestratorBridge" \
  "$app_bundle/Contents/Helpers/OrchestratorBridge"
/usr/bin/install -m 644 "$repository_root/Config/Info.plist" \
  "$app_bundle/Contents/Info.plist"
/usr/bin/install -m 644 \
  "$repository_root/Sources/OrchestratorApp/Resources/com.mattiafiumara.Orchestrator.service.plist" \
  "$app_bundle/Contents/Library/LaunchAgents/com.mattiafiumara.Orchestrator.service.plist"

for resource_bundle in "$binary_directory"/*.bundle; do
  if [[ -d "$resource_bundle" ]]; then
    /bin/cp -R "$resource_bundle" "$app_bundle/Contents/Resources/"
  fi
done

/usr/bin/plutil -lint "$app_bundle/Contents/Info.plist"
/usr/bin/plutil -lint \
  "$app_bundle/Contents/Library/LaunchAgents/com.mattiafiumara.Orchestrator.service.plist"

for executable in \
  "$app_bundle/Contents/Helpers/OrchestratorBridge" \
  "$app_bundle/Contents/Helpers/OrchestratorService"; do
  /usr/bin/codesign --force --sign - --options runtime --timestamp=none "$executable"
done

/usr/bin/codesign --force --sign - --options runtime --timestamp=none \
  --entitlements "$repository_root/Config/Orchestrator.entitlements" \
  "$app_bundle"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_bundle"

for executable in \
  "$app_bundle/Contents/MacOS/Orchestrator" \
  "$app_bundle/Contents/Helpers/OrchestratorService" \
  "$app_bundle/Contents/Helpers/OrchestratorBridge"; do
  architectures=$(/usr/bin/lipo -archs "$executable")
  if [[ "$architectures" != "arm64" ]]; then
    print -u2 "expected an arm64-only executable at $executable, found: $architectures"
    exit 70
  fi
done

print "$app_bundle"
