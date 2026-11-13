#!/usr/bin/env python3
"""Extract a Windows MSIX package (or one architecture out of an .msixbundle).

MSIX is a zip whose entry names are percent-encoded (``@scope`` is stored as
``%40scope``); a plain ``unzip`` leaves those names encoded and breaks every
scoped node module. This extractor decodes them, drops the package metadata
(Appx*, [Content_Types].xml) and refuses entries that would escape the target.

Usage: msix.py extract <package.msix|bundle.msixbundle> <dest> [--arch x64]
       msix.py identity <package.msix|bundle.msixbundle> [--arch x64]
"""
import os
import re
import shutil
import sys
import tempfile
import zipfile
from urllib.parse import unquote

METADATA = re.compile(r"^(AppxMetadata/|AppxBlockMap\.xml$|AppxSignature\.p7x$|\[Content_Types\]\.xml$)")


def pick_package(bundle: zipfile.ZipFile, arch: str) -> str:
    names = [n for n in bundle.namelist() if n.lower().endswith((".msix", ".appx"))]
    for n in names:
        if re.search(r"[-_]" + re.escape(arch) + r"\.(msix|appx)$", n, re.I):
            return n
    raise SystemExit(f"no {arch} package in bundle (has: {', '.join(names) or 'none'})")


def open_package(path: str, arch: str, scratch: str) -> zipfile.ZipFile:
    z = zipfile.ZipFile(path)
    if "AppxManifest.xml" in z.namelist():
        return z
    member = pick_package(z, arch)
    out = os.path.join(scratch, os.path.basename(member))
    with z.open(member) as src, open(out, "wb") as dst:
        shutil.copyfileobj(src, dst, 1 << 20)
    z.close()
    return zipfile.ZipFile(out)


def safe_target(dest: str, name: str) -> str:
    rel = "/".join(unquote(part) for part in name.split("/"))
    if rel.startswith("/") or "\\" in rel or any(p in ("..", "") for p in rel.rstrip("/").split("/")):
        raise SystemExit(f"refusing unsafe entry name: {name!r}")
    target = os.path.normpath(os.path.join(dest, rel))
    if not target.startswith(os.path.normpath(dest) + os.sep):
        raise SystemExit(f"refusing entry outside the target: {name!r}")
    return target


def extract(path: str, dest: str, arch: str) -> int:
    os.makedirs(dest, exist_ok=True)
    count = 0
    with tempfile.TemporaryDirectory(dir=os.path.dirname(os.path.abspath(dest))) as scratch:
        pkg = open_package(path, arch, scratch)
        for info in pkg.infolist():
            if METADATA.match(info.filename) or info.filename == "AppxManifest.xml":
                continue
            target = safe_target(dest, info.filename)
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with pkg.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            count += 1
        manifest = pkg.read("AppxManifest.xml")
        pkg.close()
    with open(os.path.join(dest, "AppxManifest.xml"), "wb") as f:
        f.write(manifest)
    return count


def identity(path: str, arch: str) -> str:
    with tempfile.TemporaryDirectory() as scratch:
        pkg = open_package(path, arch, scratch)
        xml = pkg.read("AppxManifest.xml").decode("utf-8", "replace")
        pkg.close()
    m = re.search(r"<Identity\b[^>]*>", xml)
    return m.group(0) if m else ""


def main(argv):
    if len(argv) < 3 or argv[1] not in ("extract", "identity"):
        print(__doc__, file=sys.stderr)
        return 2
    arch = "x64"
    if "--arch" in argv:
        i = argv.index("--arch")
        arch = argv[i + 1]
        del argv[i:i + 2]
    if argv[1] == "identity":
        print(identity(argv[2], arch))
        return 0
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    n = extract(argv[2], argv[3], arch)
    print(f"extracted {n} files")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
