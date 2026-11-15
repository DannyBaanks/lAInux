"""lib/asar.py against archives built here (no upstream bytes)."""
import json
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import asar  # noqa: E402


def build(path, files, unpacked=()):
    """files: {"a/b.txt": bytes}; names in `unpacked` go to <path>.unpacked/."""
    tree, blob = {"files": {}}, b""
    for name, data in files.items():
        node = tree
        parts = name.split("/")
        for p in parts[:-1]:
            node = node["files"].setdefault(p, {"files": {}})
        if name in unpacked:
            node["files"][parts[-1]] = {"size": len(data), "unpacked": True}
            dst = os.path.join(path + ".unpacked", *parts)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as f:
                f.write(data)
        else:
            node["files"][parts[-1]] = {"size": len(data), "offset": str(len(blob))}
            blob += data
    js = json.dumps(tree).encode()
    pad = (4 - len(js) % 4) % 4
    pickle = struct.pack("<2I", 4 + len(js) + pad, len(js)) + js + b"\0" * pad
    with open(path, "wb") as f:
        f.write(struct.pack("<2I", 4, len(pickle)) + pickle + blob)


class AsarTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.a = os.path.join(self.d.name, "app.asar")
        build(self.a, {"package.json": b'{"name":"x"}', "assets/icon.png": b"\x89PNG-fake",
                       "src/addon.node": b"native"}, unpacked={"src/addon.node"})

    def tearDown(self):
        self.d.cleanup()

    def test_read_packed_and_unpacked(self):
        self.assertEqual(asar.read_file(self.a, "assets/icon.png"), b"\x89PNG-fake")
        self.assertEqual(asar.read_file(self.a, "package.json"), b'{"name":"x"}')
        self.assertEqual(asar.read_file(self.a, "src/addon.node"), b"native")

    def test_listing(self):
        with open(self.a, "rb") as f:
            header, _ = asar.read_header(f)
        self.assertEqual(sorted(p for p, _ in asar.walk(header)),
                         ["assets/icon.png", "package.json", "src/addon.node"])

    def test_rejects_traversal_missing_and_directories(self):
        for bad in ("../etc/passwd", "assets/../package.json", "nope.txt", "assets"):
            with self.assertRaises(asar.AsarError):
                asar.read_file(self.a, bad)

    def test_rejects_non_asar(self):
        p = os.path.join(self.d.name, "x.bin")
        with open(p, "wb") as f:
            f.write(b"PK\x03\x04" + b"\0" * 32)
        with self.assertRaises(asar.AsarError):
            asar.read_file(p, "package.json")


if __name__ == "__main__":
    unittest.main()
