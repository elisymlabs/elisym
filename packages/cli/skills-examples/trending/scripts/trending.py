#!/usr/bin/env python3
"""Fetch trending repos from GitHub or posts from Reddit."""

import json
import sys

import requests
from bs4 import BeautifulSoup


def github_trending(language=None):
    """Scrape GitHub trending page."""
    url = "https://github.com/trending"
    if language:
        url += f"/{language}"

    headers = {"User-Agent": "Mozilla/5.0 (compatible; elisym-agent/1.0)"}

    try:
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        return {"error": f"Failed to fetch GitHub trending: {e}"}

    soup = BeautifulSoup(resp.text, "html.parser")
    articles = soup.select("article.Box-row")

    results = []
    for i, article in enumerate(articles[:25], 1):
        h2 = article.select_one("h2 a")
        if not h2:
            continue
        repo_path = h2.get("href", "").strip("/")
        name = repo_path

        desc_p = article.select_one("p")
        description = desc_p.get_text(strip=True) if desc_p else None

        stars_el = article.select_one("a[href$='/stargazers']")
        stars = stars_el.get_text(strip=True).replace(",", "") if stars_el else None

        lang_el = article.select_one("[itemprop='programmingLanguage']")
        lang = lang_el.get_text(strip=True) if lang_el else None

        results.append({
            "rank": i,
            "title": name,
            "url": f"https://github.com/{repo_path}",
            "description": description,
            "stars": stars,
            "language": lang,
        })

    return results


def reddit_trending(subreddit=None):
    """Fetch hot posts from Reddit."""
    sub = subreddit or "popular"
    url = f"https://old.reddit.com/r/{sub}/.json?limit=25"
    headers = {"User-Agent": "elisym-agent/1.0"}

    try:
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return {"error": f"Failed to fetch Reddit: {e}"}

    results = []
    children = data.get("data", {}).get("children", [])
    for i, child in enumerate(children, 1):
        post = child.get("data", {})
        results.append({
            "rank": i,
            "title": post.get("title"),
            "url": f"https://reddit.com{post.get('permalink', '')}",
            "description": post.get("selftext", "")[:200] or None,
            "score": post.get("score"),
            "subreddit": post.get("subreddit"),
        })

    return results


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: trending.py <github|reddit> [category]"}))
        sys.exit(1)

    source = sys.argv[1].lower()
    category = sys.argv[2] if len(sys.argv) > 2 else None

    if source == "github":
        result = github_trending(category)
    elif source == "reddit":
        result = reddit_trending(category)
    else:
        result = {"error": f"Unknown source: {source}. Use 'github' or 'reddit'"}

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
