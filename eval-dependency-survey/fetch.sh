#!/bin/bash
# Fetches the manifests and lockfiles of the five applications at the commits
# surveyed (2026-11-20), into ./data. Then:
#   python3 closure.py data && python3 meta.py && python3 classify.py && python3 roots.py data
set -e
cd "$(dirname "$0")"; mkdir -p data; cd data
get() { curl -sfL -o "$1" "https://raw.githubusercontent.com/$2"; }
J=81cc5227ae; M=580d0dab33; B=91f7c92e53; N=7a89690a1c; Y=684de0fad3
get jitsi.package.json jitsi/jitsi-meet/$J/package.json;             get jitsi.lock.json jitsi/jitsi-meet/$J/package-lock.json
get mattermost.package.json mattermost/mattermost/$M/webapp/channels/package.json; get mattermost.lock.json mattermost/mattermost/$M/webapp/package-lock.json
get bitwarden.package.json bitwarden/clients/$B/package.json;        get bitwarden.lock.json bitwarden/clients/$B/package-lock.json
get nextcloud.package.json nextcloud/server/$N/package.json;         get nextcloud.lock.json nextcloud/server/$N/package-lock.json
get jellyfin.package.json jellyfin/jellyfin-web/$Y/package.json;     get jellyfin.lock.json jellyfin/jellyfin-web/$Y/package-lock.json
