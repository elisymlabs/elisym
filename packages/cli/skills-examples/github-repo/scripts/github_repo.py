#!/usr/bin/env python3
"""Fetch GitHub repository information via API."""

import json
import os
import sys

import requests


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: github_repo.py <owner/repo>"}))
        sys.exit(1)

    repo = sys.argv[1]

    headers = {"Accept": "application/vnd.github.v3+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"token {token}"

    url = f"https://api.github.com/repos/{repo}"

    try:
        resp = requests.get(url, headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.HTTPError:
        if resp.status_code == 404:
            print(json.dumps({"error": f"Repository '{repo}' not found"}))
        else:
            print(json.dumps({"error": f"GitHub API error: {resp.status_code}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"Request failed: {e}"}))
        sys.exit(1)

    result = {
        "name": data.get("full_name"),
        "description": data.get("description"),
        "stars": data.get("stargazers_count"),
        "forks": data.get("forks_count"),
        "open_issues": data.get("open_issues_count"),
        "language": data.get("language"),
        "last_push": data.get("pushed_at"),
        "license": data["license"]["spdx_id"] if data.get("license") else None,
        "topics": data.get("topics", []),
    }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
