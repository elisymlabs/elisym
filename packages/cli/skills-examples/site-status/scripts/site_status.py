#!/usr/bin/env python3
"""Check website status, response time, and SSL."""

import json
import ssl
import sys
import time
from urllib.parse import urlparse

import requests


def check_ssl(hostname):
    """Check if SSL certificate is valid."""
    try:
        ctx = ssl.create_default_context()
        with ctx.wrap_socket(ssl.socket(), server_hostname=hostname) as s:
            s.settimeout(5)
            s.connect((hostname, 443))
        return True
    except Exception:
        return False


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: site_status.py <url>"}))
        sys.exit(1)

    url = sys.argv[1]
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    parsed = urlparse(url)

    try:
        start = time.time()
        resp = requests.get(url, timeout=15, allow_redirects=True)
        elapsed_ms = round((time.time() - start) * 1000)
    except requests.exceptions.ConnectionError:
        print(json.dumps({"url": url, "error": "Connection failed", "status": "down"}))
        sys.exit(1)
    except requests.exceptions.Timeout:
        print(json.dumps({"url": url, "error": "Timeout", "status": "timeout"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"url": url, "error": str(e)}))
        sys.exit(1)

    redirect_chain = []
    for r in resp.history:
        redirect_chain.append({
            "url": r.url,
            "status_code": r.status_code,
        })

    ssl_valid = None
    if parsed.scheme == "https" or resp.url.startswith("https://"):
        final_host = urlparse(resp.url).hostname
        ssl_valid = check_ssl(final_host)

    result = {
        "url": resp.url,
        "status_code": resp.status_code,
        "response_time_ms": elapsed_ms,
        "redirect_chain": redirect_chain if redirect_chain else None,
        "ssl_valid": ssl_valid,
        "server": resp.headers.get("Server"),
    }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
