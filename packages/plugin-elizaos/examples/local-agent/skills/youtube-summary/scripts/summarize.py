#!/usr/bin/env python3
"""YouTube transcript extractor with chunked output.

Usage:
    python3 summarize.py <youtube_url> --lang auto          # fetch & cache, return metadata
    python3 summarize.py <youtube_url> --chunk 0            # return chunk 0
    python3 summarize.py <youtube_url> --chunk 1            # return chunk 1

Extracts subtitles/transcript from a YouTube video.
Long transcripts are split into chunks for LLM processing.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

CHUNK_SIZE = 30_000  # ~7500 tokens, safe for rate limits
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(SCRIPT_DIR, ".cache")
COOKIES_FILE = os.path.join(os.path.dirname(SCRIPT_DIR), "cookies.txt")


def _cookies_args() -> list[str]:
    """Return yt-dlp --cookies args if cookies.txt exists."""
    if os.path.exists(COOKIES_FILE):
        return ["--cookies", COOKIES_FILE]
    return []


def video_id_from_url(url: str) -> str:
    """Extract video ID from YouTube URL."""
    m = re.search(r"(?:v=|youtu\.be/|shorts/)([a-zA-Z0-9_-]{11})", url)
    if m:
        return m.group(1)
    return hashlib.md5(url.encode()).hexdigest()[:12]


def cache_path(url: str) -> str:
    """Path to cached transcript JSON."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, f"{video_id_from_url(url)}.json")


def load_cache(url: str) -> dict | None:
    path = cache_path(url)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def save_cache(url: str, data: dict):
    path = cache_path(url)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def get_video_info(url: str) -> dict:
    """Fetch video title, duration, description, and language info."""
    result = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--dump-json", "--no-download", "--no-check-formats", *_cookies_args(), url],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        print(f"yt-dlp --dump-json failed (code {result.returncode}): {result.stderr.strip()}", file=sys.stderr)
        # Fallback: return minimal info if --dump-json fails (e.g. EJS solver issues)
        vid = video_id_from_url(url)
        return {
            "title": f"Video {vid}",
            "duration": 0,
            "channel": "Unknown",
            "description": "",
            "language": None,
            "subtitles": [],
            "automatic_captions": [],
        }
    info = json.loads(result.stdout)
    return {
        "title": info.get("title", "Unknown"),
        "duration": info.get("duration", 0),
        "channel": info.get("channel", "Unknown"),
        "description": (info.get("description") or "")[:500],
        "language": info.get("language"),
        "subtitles": list((info.get("subtitles") or {}).keys()),
        "automatic_captions": list((info.get("automatic_captions") or {}).keys()),
    }


def detect_language(video_info: dict) -> str:
    lang = video_info.get("language")
    if lang:
        return lang.split("-")[0].lower()
    subs = video_info.get("subtitles", [])
    if subs:
        return subs[0]
    auto = video_info.get("automatic_captions", [])
    if auto:
        return auto[0]
    return "en"


def fetch_subtitles(url: str, lang: str) -> str | None:
    lang_attempts = [lang]
    if lang != "en":
        lang_attempts.append("en")
    for try_lang in lang_attempts:
        result = _try_fetch_subs(url, try_lang)
        if result:
            return result
    return _try_fetch_subs_any(url)


def _try_fetch_subs(url: str, lang: str) -> str | None:
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = os.path.join(tmpdir, "subs")
        subprocess.run(
            [
                sys.executable, "-m", "yt_dlp",
                "--write-auto-sub", "--write-sub",
                "--sub-lang", lang,
                "--sub-format", "vtt",
                "--skip-download",
                *_cookies_args(),
                "-o", output_path, url,
            ],
            capture_output=True, text=True, timeout=60,
        )
        for f in os.listdir(tmpdir):
            if f.endswith(".vtt"):
                text = parse_vtt(os.path.join(tmpdir, f))
                if text and len(text.strip()) > 50:
                    return text
    return None


def _try_fetch_subs_any(url: str) -> str | None:
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = os.path.join(tmpdir, "subs")
        subprocess.run(
            [
                sys.executable, "-m", "yt_dlp",
                "--write-auto-sub", "--write-sub",
                "--sub-format", "vtt",
                "--skip-download",
                *_cookies_args(),
                "-o", output_path, url,
            ],
            capture_output=True, text=True, timeout=60,
        )
        for f in os.listdir(tmpdir):
            if f.endswith(".vtt"):
                text = parse_vtt(os.path.join(tmpdir, f))
                if text and len(text.strip()) > 50:
                    return text
    return None


def parse_vtt(path: str) -> str:
    lines = []
    seen = set()
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
                continue
            if re.match(r"^\d{2}:\d{2}", line) or "-->" in line:
                continue
            clean = re.sub(r"<[^>]+>", "", line)
            if clean and clean not in seen:
                seen.add(clean)
                lines.append(clean)
    return " ".join(lines)


def transcribe_audio(url: str) -> str:
    try:
        import whisper
    except ImportError:
        raise RuntimeError(
            "No subtitles available and Whisper is not installed. "
            "Install with: pip install openai-whisper"
        )
    with tempfile.TemporaryDirectory() as tmpdir:
        audio_path = os.path.join(tmpdir, "audio.mp3")
        print("Downloading audio...", file=sys.stderr)
        result = subprocess.run(
            [sys.executable, "-m", "yt_dlp", "-x", "--audio-format", "mp3", "--audio-quality", "5", *_cookies_args(), "-o", audio_path, url],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Audio download failed: {result.stderr.strip()}")
        actual_path = audio_path
        if not os.path.exists(actual_path):
            for f in os.listdir(tmpdir):
                if f.startswith("audio"):
                    actual_path = os.path.join(tmpdir, f)
                    break
        print("Transcribing with Whisper...", file=sys.stderr)
        model = whisper.load_model("base")
        result = model.transcribe(actual_path)
        return result["text"]


def split_chunks(text: str) -> list[str]:
    """Split text into chunks, breaking at sentence boundaries."""
    if len(text) <= CHUNK_SIZE:
        return [text]
    chunks = []
    while text:
        if len(text) <= CHUNK_SIZE:
            chunks.append(text)
            break
        # Find last sentence boundary within chunk size
        cut = CHUNK_SIZE
        for sep in [". ", "! ", "? ", "\n"]:
            pos = text.rfind(sep, 0, CHUNK_SIZE)
            if pos > CHUNK_SIZE // 2:
                cut = pos + len(sep)
                break
        chunks.append(text[:cut])
        text = text[cut:]
    return chunks


def main():
    parser = argparse.ArgumentParser(description="Extract transcript from a YouTube video")
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("--lang", default="auto", help="Subtitle language or 'auto'")
    parser.add_argument("--chunk", type=int, default=None, help="Return specific chunk (0-indexed)")
    args = parser.parse_args()

    if not re.search(r"(youtube\.com|youtu\.be)", args.url):
        print("Error: not a valid YouTube URL", file=sys.stderr)
        sys.exit(1)

    # If requesting a specific chunk, read from cache
    if args.chunk is not None:
        cached = load_cache(args.url)
        if not cached:
            print("Error: no cached transcript. Call without --chunk first.", file=sys.stderr)
            sys.exit(1)
        chunks = cached["chunks"]
        if args.chunk < 0 or args.chunk >= len(chunks):
            print(f"Error: chunk {args.chunk} out of range (0-{len(chunks)-1})", file=sys.stderr)
            sys.exit(1)
        output = json.dumps({
            "title": cached["title"],
            "chunk": args.chunk,
            "total_chunks": len(chunks),
            "transcript": chunks[args.chunk],
        }, ensure_ascii=False, indent=2)
        print(output)
        return

    # Fetch transcript
    print("Fetching video info...", file=sys.stderr)
    video_info = get_video_info(args.url)
    print(f"Video: {video_info['title']} ({video_info['duration'] // 60} min)", file=sys.stderr)

    if args.lang == "auto":
        lang = detect_language(video_info)
        print(f"Detected language: {lang}", file=sys.stderr)
    else:
        lang = args.lang

    print(f"Fetching subtitles (lang={lang})...", file=sys.stderr)
    transcript = fetch_subtitles(args.url, lang)

    if not transcript:
        print("No subtitles found, trying Whisper transcription...", file=sys.stderr)
        try:
            transcript = transcribe_audio(args.url)
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)

    if not transcript or len(transcript.strip()) < 50:
        print("Error: could not extract transcript from video", file=sys.stderr)
        sys.exit(1)

    chunks = split_chunks(transcript)
    print(f"Transcript: {len(transcript)} chars, {len(chunks)} chunk(s)", file=sys.stderr)

    # Cache for chunk retrieval
    save_cache(args.url, {
        "title": video_info["title"],
        "channel": video_info["channel"],
        "duration_min": video_info["duration"] // 60,
        "language": lang,
        "chunks": chunks,
    })

    # Return metadata + first chunk inline
    output = json.dumps({
        "title": video_info["title"],
        "channel": video_info["channel"],
        "duration_min": video_info["duration"] // 60,
        "language": lang,
        "total_chunks": len(chunks),
        "chunk": 0,
        "transcript": chunks[0],
    }, ensure_ascii=False, indent=2)
    print(output)


if __name__ == "__main__":
    main()
