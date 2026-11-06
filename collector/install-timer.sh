#!/bin/sh
# Install (or re-install) the collector as a systemd user timer for the current user, run it once, and start the timer.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed -e "s#@PROJECT@#$(dirname "$HERE")#g" -e "s#@HOME@#$HOME#g" "$HERE/systemd/token-overview-collector.service" > "$UNIT_DIR/token-overview-collector.service"
cp "$HERE/systemd/token-overview-collector.timer" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now token-overview-collector.timer
systemctl --user start token-overview-collector.service
systemctl --user --no-pager list-timers token-overview-collector.timer
echo "Last run:"; journalctl --user -u token-overview-collector.service -n 3 --no-pager -o cat
