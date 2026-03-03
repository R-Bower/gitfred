#!/usr/bin/env bash
# Records the selected repo into the recent-public-repos list.
# Runs concurrently (fire-and-forget) alongside the user's actual action.

# Guard: skip placeholder items that have no repo data
[[ -z "$recent_repo_full_name" ]] && exit 0

mkdir -p "$alfred_workflow_data"
RECENTS_FILE="$alfred_workflow_data/recent-public-repos.json"

python3 -c "
import json, os, sys

recents_file = os.environ['alfred_workflow_data'] + '/recent-public-repos.json'
entry = {
    'full_name': os.environ.get('recent_repo_full_name', ''),
    'name': os.environ.get('recent_repo_name', ''),
    'owner': os.environ.get('recent_repo_owner', ''),
    'html_url': os.environ.get('recent_repo_html_url', ''),
    'stars': int(os.environ.get('recent_repo_stars', '0')),
    'description': os.environ.get('recent_repo_description', ''),
    'homepage': os.environ.get('recent_repo_homepage', ''),
}

try:
    with open(recents_file, 'r') as f:
        recents = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    recents = []

# Deduplicate: remove existing entry with the same full_name
recents = [r for r in recents if r.get('full_name') != entry['full_name']]

# Prepend new entry and trim to 100
recents.insert(0, entry)
recents = recents[:100]

# Atomic write
tmp = recents_file + '.tmp'
with open(tmp, 'w') as f:
    json.dump(recents, f)
os.replace(tmp, recents_file)
"
