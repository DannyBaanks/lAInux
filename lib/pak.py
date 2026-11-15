#!/usr/bin/env python3
"""Read Chromium .pak files (format v4 and v5), stdlib only.

Used by lAInux recipes for apps whose UI ships inside Chromium resource packs
(e.g. Dola/Doubao's biz.pak). Read-only: nothing here writes vendor bytes into
the repository; extraction always goes to a caller-chosen directory.

v5 layout (little endian):
  u32 version=5, u8 encoding, 3 pad, u16 resource_count, u16 alias_count,
  (resource_count + 1) x { u16 id, u32 offset }   # last entry = end sentinel
  alias_count x { u16 id, u16 entry_index }
  data...
v4 layout: u32 version=4, u32 resource_count, u8 encoding, then the same table.
Resources may be gzip (1f 8b) or Chromium-brotli (1e 9b + 6-byte size) compressed.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import struct
import sys
from dataclasses import dataclass

ENCODINGS = {0: "binary", 1: "utf-8", 2: "utf-16"}


class PakError(ValueError):
    pass


@dataclass
class Pak:
    version: int
    encoding: int
    resources: dict[int, tuple[int, int]]   # id -> (offset, end)
    aliases: dict[int, int]                 # alias id -> target id
    data: bytes

    def raw(self, rid: int) -> bytes:
        rid = self.aliases.get(rid, rid)
        off, end = self.resources[rid]
        return self.data[off:end]

    def get(self, rid: int) -> tuple[bytes, str]:
        """Decoded bytes and the compression that was removed ('', 'gzip', 'brotli')."""
        b = self.raw(rid)
        if b[:2] == b"\x1f\x8b":
            return gzip.decompress(b), "gzip"
        if b[:2] == b"\x1e\x9b" and len(b) > 8:
            try:
                import brotli  # optional
            except ImportError:
                return b, "brotli-undecoded"
            return brotli.decompress(b[8:]), "brotli"
        return b, ""

    def ids(self) -> list[int]:
        return sorted(set(self.resources) | set(self.aliases))


def parse(data: bytes) -> Pak:
    if len(data) < 12:
        raise PakError("file too small for a pak header")
    version = struct.unpack_from("<I", data, 0)[0]
    if version == 5:
        encoding = data[4]
        count, alias_count = struct.unpack_from("<HH", data, 8)
        table = 12
    elif version == 4:
        count = struct.unpack_from("<I", data, 4)[0]
        encoding, alias_count, table = data[8], 0, 9
    else:
        raise PakError(f"unsupported pak version {version}")
    need = table + (count + 1) * 6 + alias_count * 4
    if need > len(data):
        raise PakError(f"index ({need} bytes) larger than file ({len(data)})")
    entries = [struct.unpack_from("<HI", data, table + i * 6) for i in range(count + 1)]
    resources = {}
    for (rid, off), (_, end) in zip(entries, entries[1:]):
        if not (0 < off <= end <= len(data)):
            raise PakError(f"resource {rid}: bad bounds {off}..{end} (file {len(data)})")
        resources[rid] = (off, end)
    aliases = {}
    base = table + (count + 1) * 6
    for i in range(alias_count):
        aid, idx = struct.unpack_from("<HH", data, base + i * 4)
        if idx >= count:
            raise PakError(f"alias {aid} points past the table ({idx})")
        aliases[aid] = entries[idx][0]
    return Pak(version, encoding, resources, aliases, data)


def manifest_paths(p: Pak) -> dict[int, str]:
    """ByteDance-style index: resource 1 is JSON {"entries": [{"id", "path"}], ...}.
    Returns {} when the pack has no such index. Paths are validated: relative, no '..'."""
    if 1 not in p.resources:
        return {}
    try:
        idx = json.loads(p.get(1)[0])
    except (ValueError, UnicodeDecodeError):
        return {}
    out = {}
    for e in idx.get("entries", []) if isinstance(idx, dict) else []:
        rid, path = e.get("id"), str(e.get("path", ""))
        norm = os.path.normpath(path)
        if not path or os.path.isabs(path) or norm.startswith("..") or "\0" in path:
            raise PakError(f"unsafe path in pak index: {path!r}")
        if rid not in p.resources and rid not in p.aliases:
            raise PakError(f"pak index names missing resource {rid} ({path})")
        out[rid] = norm
    return out


def sniff(b: bytes) -> str:
    head = b[:64].lstrip()
    if head[:1] in (b"{", b"[") and b"\n" not in head[:1]:
        return "json?"
    if head[:5].lower() in (b"<!doc", b"<html") or head[:1] == b"<":
        return "html/xml"
    if head[:4] == b"\x00asm":
        return "wasm"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:3] == b"GIF" or head[:2] == b"\xff\xd8":
        return "image"
    if head[:4] in (b"wOFF", b"wOF2"):
        return "font"
    try:
        b[:4096].decode("utf-8")
        return "text"
    except UnicodeDecodeError:
        return "binary"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Inspect or extract a Chromium .pak")
    ap.add_argument("pak")
    ap.add_argument("--list", action="store_true", help="one JSON line per resource")
    ap.add_argument("--extract", metavar="DIR", help="write every resource to DIR/<id>.<kind>")
    ap.add_argument("--extract-tree", metavar="DIR", help="write resources by the pak's own path index")
    a = ap.parse_args(argv)
    with open(a.pak, "rb") as f:
        pak = parse(f.read())
    summary = {"version": pak.version, "encoding": ENCODINGS.get(pak.encoding, pak.encoding),
               "resources": len(pak.resources), "aliases": len(pak.aliases)}
    kinds: dict[str, int] = {}
    for rid in pak.ids():
        body, comp = pak.get(rid)
        kind = sniff(body)
        kinds[kind] = kinds.get(kind, 0) + 1
        if a.list:
            print(json.dumps({"id": rid, "bytes": len(body), "compression": comp, "kind": kind,
                              "sha256": hashlib.sha256(body).hexdigest()}))
        if a.extract:
            os.makedirs(a.extract, exist_ok=True)
            ext = {"json?": "json", "html/xml": "html", "text": "txt"}.get(kind, kind.split("/")[0])
            with open(os.path.join(a.extract, f"{rid}.{ext}"), "wb") as f:
                f.write(body)
    if a.extract_tree:
        paths = manifest_paths(pak)
        if not paths:
            raise PakError("this pak has no path index (resource 1)")
        root = os.path.realpath(a.extract_tree)
        for rid, rel in paths.items():
            dst = os.path.realpath(os.path.join(root, rel))
            if not dst.startswith(root + os.sep):
                raise PakError(f"path escapes the output dir: {rel}")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as f:
                f.write(pak.get(rid)[0])
        summary["tree_files"] = len(paths)
    summary["kinds"] = kinds
    print(json.dumps(summary), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
