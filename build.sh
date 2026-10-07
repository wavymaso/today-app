#!/bin/bash
# Build Today.app into dist/.   ./build.sh            build only
#                               ./build.sh --install  build, then replace /Applications/Today.app
set -euo pipefail
cd "$(dirname "$0")"

INSTALL=0
[[ "${1:-}" == "--install" ]] && INSTALL=1

if [[ ! -x .venv/bin/python ]]; then
  echo "==> Creating virtualenv"
  python3 -m venv .venv
fi
echo "==> Installing dependencies"
.venv/bin/pip install -q -r requirements.txt -r requirements-dev.txt

if [[ ! -f macos/Today.icns ]]; then
  echo "==> Drawing the icon"
  .venv/bin/python macos/make_icon.py
fi

echo "==> Running tests"
.venv/bin/python -m pytest -q

echo "==> Building Today.app"
rm -rf build dist
.venv/bin/pyinstaller macos/Today.spec --noconfirm --clean --log-level WARN --distpath dist --workpath build
echo "    $(du -sh dist/Today.app | cut -f1)  dist/Today.app"

if [[ $INSTALL == 1 ]]; then
  if pgrep -xq Today; then
    echo "==> Quitting the running Today app"
    osascript -e 'quit app "Today"' || true
    for _ in {1..20}; do pgrep -xq Today || break; sleep 0.25; done
  fi
  echo "==> Installing to /Applications/Today.app"
  rm -rf /Applications/Today.app
  ditto dist/Today.app /Applications/Today.app
  rm -rf dist build
  echo "Done. Open Today from Spotlight, Launchpad or the Applications folder."
else
  echo "Done. Drag dist/Today.app into Applications, or run ./build.sh --install"
fi
