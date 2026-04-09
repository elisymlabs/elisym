#!/usr/bin/env python3
"""Fetch stock quote using yfinance."""

import json
import sys

import yfinance as yf


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: stock_price.py <ticker>"}))
        sys.exit(1)

    ticker = sys.argv[1].upper()

    try:
        stock = yf.Ticker(ticker)
        info = stock.info
    except Exception as e:
        print(json.dumps({"error": f"yfinance failed: {e}"}))
        sys.exit(1)

    if not info or info.get("regularMarketPrice") is None:
        print(json.dumps({"error": f"No data found for ticker '{ticker}'"}))
        sys.exit(1)

    price = info.get("regularMarketPrice") or info.get("currentPrice")
    prev_close = info.get("regularMarketPreviousClose")
    change = round(price - prev_close, 2) if price and prev_close else None
    change_pct = round((change / prev_close) * 100, 2) if change and prev_close else None

    result = {
        "ticker": ticker,
        "name": info.get("shortName") or info.get("longName"),
        "price": price,
        "change": change,
        "change_percent": change_pct,
        "volume": info.get("regularMarketVolume"),
        "market_cap": info.get("marketCap"),
        "52w_high": info.get("fiftyTwoWeekHigh"),
        "52w_low": info.get("fiftyTwoWeekLow"),
    }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
