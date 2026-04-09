#!/usr/bin/env python3
"""WHOIS lookup for a domain."""

import json
import sys
from datetime import datetime, timezone

import whois


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: whois_lookup.py <domain>"}))
        sys.exit(1)

    domain = sys.argv[1]

    try:
        w = whois.whois(domain)
    except Exception as e:
        print(json.dumps({"error": f"WHOIS lookup failed: {e}"}))
        sys.exit(1)

    creation = w.creation_date
    if isinstance(creation, list):
        creation = creation[0]

    expiry = w.expiration_date
    if isinstance(expiry, list):
        expiry = expiry[0]

    age_days = None
    if creation:
        now = datetime.now(timezone.utc)
        if creation.tzinfo is None:
            creation = creation.replace(tzinfo=timezone.utc)
        age_days = (now - creation).days

    name_servers = w.name_servers
    if name_servers and isinstance(name_servers, (list, set)):
        name_servers = sorted(set(ns.lower() for ns in name_servers))

    status = w.status
    if isinstance(status, list):
        status = status
    elif status:
        status = [status]
    else:
        status = []

    result = {
        "domain": w.domain_name if w.domain_name else domain,
        "registrar": w.registrar,
        "creation_date": str(creation) if creation else None,
        "expiry_date": str(expiry) if expiry else None,
        "age_days": age_days,
        "name_servers": name_servers,
        "status": status,
    }

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
