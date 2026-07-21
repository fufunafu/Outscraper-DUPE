#!/bin/bash
#
# Build "Places Scraper.app" — a fully self-contained, double-clickable Mac app.
#
# The bundle carries its own copy of the Node runtime and the app source, so it
# runs on a Mac with nothing installed: copy the .app to any machine (or just
# /Applications), double-click, and the browser opens. All data stays in that
# machine's ~/Documents/Places Scraper — the .app itself is stateless, so
# rebuilding or replacing it never touches the database.
#
# Usage:  bash apps/desktop/package-app.sh [destination-dir]
# Default destination is the Desktop.

set -euo pipefail

DEST="${1:-$HOME/Desktop}"
APP="$DEST/Places Scraper.app"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# The bundled runtime must be the official nodejs.org build: it is a single
# self-contained binary. A Homebrew node links half a dozen Homebrew dylibs
# and breaks the moment the .app lands on a machine without them.
ARCH="$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)"
WANT="$(node -v 2>/dev/null || echo v22.14.0)"
CACHE="$HOME/Library/Caches/places-scraper"
mkdir -p "$CACHE"

fetch_node() {
  local version="$1"
  local name="node-$version-darwin-$ARCH"
  local cached="$CACHE/$name-bin"
  if [ ! -f "$cached" ]; then
    echo "Downloading official Node runtime $version ($ARCH)…"
    curl -fsSL "https://nodejs.org/dist/$version/$name.tar.gz" -o "$CACHE/$name.tar.gz" || return 1
    tar -xzf "$CACHE/$name.tar.gz" -C "$CACHE" "$name/bin/node"
    mv "$CACHE/$name/bin/node" "$cached"
    rm -rf "$CACHE/$name" "$CACHE/$name.tar.gz"
  fi
  NODE_RUNTIME="$cached"
}

fetch_node "$WANT" || fetch_node "v22.14.0" || { echo "Could not download a Node runtime." >&2; exit 1; }

echo "Building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app/node_modules"

cp "$NODE_RUNTIME" "$APP/Contents/Resources/node"
chmod +x "$APP/Contents/Resources/node"

# The source: engine + desktop app + the single runtime dependency.
rsync -a --exclude '.git' --exclude 'node_modules' --exclude '*.test.ts' \
  "$ROOT/packages" "$ROOT/apps" "$APP/Contents/Resources/app/"
rsync -a "$ROOT/node_modules/undici" "$APP/Contents/Resources/app/node_modules/"
cp "$ROOT/package.json" "$APP/Contents/Resources/app/package.json"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Places Scraper</string>
  <key>CFBundleDisplayName</key><string>Places Scraper</string>
  <key>CFBundleIdentifier</key><string>local.places-scraper</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# The supervisor: keeps exactly one server alive forever. It respawns the
# process if it exits (a crash or OOM — which the in-process handlers can't
# always prevent) and, via a parallel watchdog, force-restarts it if it stops
# answering for ~2 minutes (a hang: event loop stuck, not exited). A backoff
# guard stops a hot-loop when the server can't even start. Every real failure
# self-heals in seconds, and the campaign auto-resumes from its checkpoints.
cat > "$APP/Contents/Resources/supervisor.sh" <<'SUP'
#!/bin/bash
RES="$(cd "$(dirname "$0")" && pwd)"
URL="http://127.0.0.1:4317"
LOG="$HOME/Library/Logs/PlacesScraper.log"
MAIN="$RES/app/apps/desktop/src/main.ts"

# Watchdog: if the server goes unresponsive for ~2 min, kill it so the
# supervisor loop below respawns a fresh one.
(
  misses=0
  while true; do
    /bin/sleep 30
    if /usr/bin/curl -s -m 5 "$URL/" >/dev/null 2>&1; then
      misses=0
    else
      misses=$((misses + 1))
      if [ "$misses" -ge 4 ]; then
        echo "[watchdog $(date '+%H:%M:%S')] unresponsive ~2min — forcing restart." >> "$LOG"
        /usr/bin/pkill -9 -f "apps/desktop/src/main.ts"
        misses=0
      fi
    fi
  done
) &

fails=0
while true; do
  started=$(date +%s)
  # NO_OPEN so a respawn never reopens the browser. Roomy heap for map queries
  # plus concurrent crawling.
  NO_OPEN=1 "$RES/node" --experimental-strip-types --no-warnings \
    --max-old-space-size=4096 "$MAIN" >> "$LOG" 2>&1
  ran=$(( $(date +%s) - started ))
  if [ "$ran" -gt 30 ]; then fails=0; else fails=$((fails + 1)); fi
  if [ "$fails" -ge 6 ]; then
    echo "[supervisor $(date '+%H:%M:%S')] exited $fails times in a row quickly — stopping." >> "$LOG"
    exit 1
  fi
  echo "[supervisor $(date '+%H:%M:%S')] server exited after ${ran}s — restarting." >> "$LOG"
  /bin/sleep 3
done
SUP
chmod +x "$APP/Contents/Resources/supervisor.sh"

cat > "$APP/Contents/MacOS/launcher" <<'SH'
#!/bin/bash
# Double-click entry point: start the supervised server if it isn't up, open UI.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
URL="http://127.0.0.1:4317"

if ! /usr/bin/curl -s -m 1 "$URL/" >/dev/null 2>&1; then
  # Detach the supervisor so it outlives this launcher process.
  /usr/bin/nohup "$RES/supervisor.sh" >/dev/null 2>&1 &
  for _ in $(seq 1 60); do
    /usr/bin/curl -s -m 1 "$URL/" >/dev/null 2>&1 && break
    /bin/sleep 0.5
  done
fi

/usr/bin/open "$URL"
SH
chmod +x "$APP/Contents/MacOS/launcher"

# Ad-hoc sign so Gatekeeper on this machine is content; a copied bundle may
# need a one-time right-click → Open on another Mac.
codesign --force --deep --sign - "$APP" 2>/dev/null || true

SIZE=$(du -sh "$APP" | cut -f1)
echo "Done: $APP ($SIZE)"
echo "Double-click it. To share: copy the whole .app to another Mac (right-click → Open the first time)."
