#!/bin/sh
# Compatibility entry point for commands and bookmarks created before the
# package rename. New documentation uses install-asclash.sh.

INSTALLER_URL="https://github.com/Desonator/ASClash/raw/refs/heads/main/install-asclash.sh"
INSTALLER_FILE="/tmp/asclash-installer-$$.sh"

if command -v curl >/dev/null 2>&1; then
	curl -fL --retry 2 "$INSTALLER_URL" -o "$INSTALLER_FILE" || exit 1
else
	wget --no-proxy -qO "$INSTALLER_FILE" "$INSTALLER_URL" || exit 1
fi

if ash "$INSTALLER_FILE" "$@"; then
	result=0
else
	result=$?
fi
rm -f "$INSTALLER_FILE"
exit "$result"
