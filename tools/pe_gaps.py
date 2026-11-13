#!/usr/bin/env python3
"""Static gap report: what a set of PE images needs vs what WINS implements.

Nothing is executed. For every image: machine, imports (normal + delay, by name or
ordinal), TLS directory (callbacks), exception directory (.pdata entries), load
config (security cookie, CFG flags), relocations. Each imported function is then
classified against the WINS source tree:

  x64      a symbol with that name exists in the x86-64 loader (winrun / winrun_impl)
  32-only  implemented for winrun32 (the logic exists; needs an x64 ABI port)
  missing  no implementation anywhere in native/*.zig

usage: pe_gaps.py --wins WINS_DIR IMAGE.dll [IMAGE.dll ...] [--json OUT]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

DIRS = ["export", "import", "resource", "exception", "security", "basereloc", "debug", "arch",
        "globalptr", "tls", "load_config", "bound_import", "iat", "delay_import", "clr", "reserved"]


def parse(path: Path) -> dict:
    d = path.read_bytes()
    if d[:2] != b"MZ":
        raise ValueError(f"{path}: not MZ")
    pe = struct.unpack_from("<I", d, 0x3C)[0]
    if d[pe:pe + 4] != b"PE\0\0":
        raise ValueError(f"{path}: no PE signature")
    machine, nsec = struct.unpack_from("<HH", d, pe + 4)
    osz = struct.unpack_from("<H", d, pe + 20)[0]
    chars = struct.unpack_from("<H", d, pe + 22)[0]
    opt = pe + 24
    magic = struct.unpack_from("<H", d, opt)[0]
    is64 = magic == 0x20B
    dllchars = struct.unpack_from("<H", d, opt + 70)[0]
    dd = opt + (112 if is64 else 96)
    ndd = struct.unpack_from("<I", d, dd - 4)[0]
    dirs = {DIRS[i]: struct.unpack_from("<II", d, dd + 8 * i) for i in range(min(ndd, 16))}
    secs = [struct.unpack_from("<8sIIII", d, opt + osz + 40 * i) for i in range(nsec)]

    def off(rva):
        for _n, vs, va, rs, ro in secs:
            if va <= rva < va + max(vs, rs):
                return rva - va + ro
        return None

    def cstr(rva):
        o = off(rva)
        return d[o:d.index(b"\0", o)].decode("latin-1") if o is not None else f"<rva {rva:#x}>"

    ptr = 8 if is64 else 4
    ord_flag = 1 << (63 if is64 else 31)

    def thunks(rva):
        out, o = [], off(rva)
        while o is not None:
            v = struct.unpack_from("<Q" if is64 else "<I", d, o)[0]
            if v == 0:
                break
            out.append(f"#{v & 0xFFFF}" if v & ord_flag else cstr((v & 0x7FFFFFFF) + 2))
            o += ptr
        return out

    imports: dict[str, list[str]] = defaultdict(list)
    rva, _ = dirs.get("import", (0, 0))
    o = off(rva) if rva else None
    while o is not None:
        ilt, _ts, _fw, name, iat = struct.unpack_from("<IIIII", d, o)
        if name == 0:
            break
        imports[cstr(name).lower()] += thunks(ilt or iat)
        o += 20
    delay: dict[str, list[str]] = defaultdict(list)
    rva, _ = dirs.get("delay_import", (0, 0))
    o = off(rva) if rva else None
    while o is not None:
        attrs, name, _hmod, _iat, int_rva = struct.unpack_from("<IIIII", d, o)[:5]
        if name == 0:
            break
        delay[cstr(name).lower()] += thunks(int_rva)
        o += 32

    tls = {}
    rva, size = dirs.get("tls", (0, 0))
    if rva and off(rva) is not None:
        fmt = "<QQQQII" if is64 else "<IIIIII"
        start, end, idx, cbs, zero, ch = struct.unpack_from(fmt, d, off(rva))
        imagebase = struct.unpack_from("<Q" if is64 else "<I", d, opt + (24 if is64 else 28))[0]
        n, co = 0, off(cbs - imagebase) if cbs else None
        while co is not None and struct.unpack_from("<Q" if is64 else "<I", d, co)[0]:
            n += 1
            co += ptr
        tls = {"raw_data_bytes": end - start, "callbacks": n}
    exc_rva, exc_size = dirs.get("exception", (0, 0))
    lc_rva, lc_size = dirs.get("load_config", (0, 0))
    guard = None
    if lc_rva and is64 and off(lc_rva) is not None and lc_size >= 0x94:
        guard = struct.unpack_from("<I", d, off(lc_rva) + 0x90)[0]
    return {
        "file": path.name, "bytes": len(d), "sha256": hashlib.sha256(d).hexdigest(),
        "machine": hex(machine), "pe32plus": is64, "dll": bool(chars & 0x2000),
        "dllcharacteristics": hex(dllchars), "imports": dict(imports), "delay_imports": dict(delay),
        "tls": tls, "pdata_entries": exc_size // 12 if is64 else 0,
        "load_config": bool(lc_rva), "cfg_guard_flags": hex(guard) if guard is not None else None,
        "relocations": bool(dirs.get("basereloc", (0, 0))[0]),
    }


def wins_symbols(wins: Path) -> tuple[set[str], set[str]]:
    """Names WINS implements: x64 loader vs everything (32-bit included)."""
    native = wins / "native"
    fn = re.compile(r"\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
    strname = re.compile(r'"([A-Za-z_][A-Za-z0-9_]{2,})"')
    x64, every = set(), set()
    for z in native.glob("*.zig"):
        txt = z.read_text(errors="replace")
        names = set(fn.findall(txt)) | set(strname.findall(txt))
        every |= names
        if z.name in ("winrun.zig", "winrun_impl.zig"):
            x64 |= names
    return x64, every


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wins", required=True, type=Path)
    ap.add_argument("--json", type=Path)
    ap.add_argument("images", nargs="+", type=Path)
    a = ap.parse_args(argv)
    x64, every = wins_symbols(a.wins)
    inner = {p.name.lower() for p in a.images}
    report = {"images": [], "gaps": {}}
    totals = Counter()
    for img in a.images:
        info = parse(img)
        report["images"].append(info)
        for dll, funcs in list(info["imports"].items()) + [(k + " (delay)", v) for k, v in info["delay_imports"].items()]:
            base = dll.replace(" (delay)", "")
            if base in inner:
                continue  # provided by another image in the set
            for f in funcs:
                cls = "x64" if f in x64 else "32-only" if f in every else "missing"
                report["gaps"].setdefault(base, {}).setdefault(cls, set()).add(f)
    for dll, by in report["gaps"].items():
        for cls, names in by.items():
            totals[cls] += len(names)
            by[cls] = sorted(names)
    report["totals"] = dict(totals)
    if a.json:
        a.json.write_text(json.dumps(report, indent=1))
    for info in report["images"]:
        print(f"{info['file']}: {info['bytes']/1e6:.1f} MB machine={info['machine']} dll={info['dll']} "
              f"tls={info['tls'] or 'none'} pdata={info['pdata_entries']} cfg={info['cfg_guard_flags']} "
              f"delay={sorted(info['delay_imports'])}")
    print(f"\n{'DLL':38} {'x64':>5} {'32-only':>8} {'missing':>8}")
    for dll, by in sorted(report["gaps"].items(), key=lambda kv: -sum(len(v) for v in kv[1].values())):
        print(f"{dll:38} {len(by.get('x64', [])):5} {len(by.get('32-only', [])):8} {len(by.get('missing', [])):8}")
    print(f"{'TOTAL':38} {totals['x64']:5} {totals['32-only']:8} {totals['missing']:8}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
