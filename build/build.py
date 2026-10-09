#!/usr/bin/env python3
"""Assemble the single-file BROADSIDE build:
head.html + three.min.js + logic.js + game.js -> index.html
Also scans music/sailing/ + music/combat/ for mp3s -> music.json (plus an inlined
window.__MUSIC_FALLBACK copy, so file:// works too).

Usage: python3 build.py [--out DIR]
  --out DIR : write index.html + music.json into DIR (mp3 folders read from DIR/music/)
  default   : repo-style <build.py dir>/.. when that dir contains music/ or
              .git, otherwise the legacy dev target
              ~/workspace/your_files/broadside/
"""
import argparse
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).parent

# --- name-collision check: at brace depth 0, logic.js must declare exactly one
# --- name (BS); game.js must declare none (fully wrapped in an IIFE).
def top_level_names(src):
    # strip strings and comments with a small state machine
    out = []
    i, n = 0, len(src)
    mode = None  # None | "'" | '"' | '`' | '//' | '/*'
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if mode is None:
            if c == "/" and nxt == "/": mode = "//"; i += 2; continue
            if c == "/" and nxt == "*": mode = "/*"; i += 2; continue
            if c in "'\"`": mode = c; i += 1; continue
            out.append(c); i += 1
        elif mode == "//":
            if c == "\n": mode = None; out.append(c)
            i += 1
        elif mode == "/*":
            if c == "*" and nxt == "/": mode = None; i += 2
            else: i += 1
        else:  # string
            if c == "\\": i += 2; continue
            if c == mode: mode = None
            i += 1
    code = "".join(out)
    names = set()
    depth = 0
    for line in code.split("\n"):
        m = re.match(r"\s*(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)", line)
        if m and depth == 0:
            names.add(m.group(1))
        depth += line.count("{") - line.count("}")
    return names

def find_outdir(cli_out):
    if cli_out:
        return pathlib.Path(cli_out)
    parent = root.parent
    if (parent / "music" / "sailing").is_dir() or (parent / ".git").is_dir():
        return parent  # repo-style: build/ is a child of the project root
    # legacy dev flow
    return pathlib.Path.home() / "workspace" / "your_files" / "broadside"

def scan_music(outdir):
    """Paths (relative to index.html) of *.mp3 per mood folder; missing/empty -> []."""
    manifest = {}
    for mood in ("sailing", "combat"):
        d = outdir / "music" / mood
        files = []
        if d.is_dir():
            files = sorted("music/" + mood + "/" + p.name for p in d.iterdir()
                           if p.is_file() and p.suffix.lower() == ".mp3")
        manifest[mood] = files
    return manifest

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=None, help="output dir for index.html + music.json")
outdir = find_outdir(ap.parse_args().out)

logic = (root / "logic.js").read_text()
game = (root / "game.js").read_text()
assert top_level_names(logic) == {"BS"}, f"logic.js top-level: {top_level_names(logic)}"
assert top_level_names(game) == set(), f"game.js top-level: {top_level_names(game)}"

manifest = scan_music(outdir)
(outdir / "music.json").write_text(json.dumps(manifest, indent=1) + "\n")

head = (root / "head.html").read_text()
three = (root / "three.min.js").read_text()
fallback = ("<script>\nwindow.__MUSIC_FALLBACK = "
            + json.dumps(manifest) + ";\n</script>\n")

out = (
    head                      # head.html already ends with an open <script> tag
    + three + "\n</script>\n"
    + "<script>\n" + logic + "\n</script>\n"
    + fallback                 # before game.js: backup if music.json can't load
    + "<script>\n" + game + "\n</script>\n"
    + "</body>\n</html>\n"
)

outdir.mkdir(parents=True, exist_ok=True)
dest = outdir / "index.html"
dest.write_text(out)
print("wrote", dest, f"({len(out) / 1024:.0f} KB)")
print("music:", {k: len(v) for k, v in manifest.items()})
