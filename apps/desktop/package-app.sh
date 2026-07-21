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

cat > "$APP/Contents/MacOS/launcher" <<'SH'
#!/bin/bash
# Double-click entry point: start the server if it isn't running, open the UI.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
PORT=4317
URL="http://127.0.0.1:$PORT"

if ! /usr/bin/curl -s -m 1 "$URL/" >/dev/null 2>&1; then
  # Roomy heap: a whole-database map query plus concurrent site crawling can
  # spike allocations; the default limit is what an OOM crash landed on.
  /usr/bin/nohup "$RES/node" --experimental-strip-types --no-warnings \
    --max-old-space-size=4096 \
    "$RES/app/apps/desktop/src/main.ts" \
    >> "$HOME/Library/Logs/PlacesScraper.log" 2>&1 &
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
