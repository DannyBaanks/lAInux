"""lib/pak.py against synthetic packs built here (no vendor bytes)."""
import gzip
import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import pak  # noqa: E402


def build_v5(items: dict[int, bytes], aliases: dict[int, int] | None = None, encoding: int = 1) -> bytes:
    """Independent writer (the oracle): Chromium's v5 layout written by hand."""
    aliases = aliases or {}
    ids = sorted(items)
    header = struct.pack("<IB3xHH", 5, encoding, len(ids), len(aliases))
    index_len = (len(ids) + 1) * 6 + len(aliases) * 4
    off = len(header) + index_len
    table, blob = b"", b""
    for rid in ids:
        table += struct.pack("<HI", rid, off + len(blob))
        blob += items[rid]
    table += struct.pack("<HI", 0, off + len(blob))
    alias_tbl = b"".join(struct.pack("<HH", a, ids.index(t)) for a, t in sorted(aliases.items()))
    return header + table + alias_tbl + blob


class PakTest(unittest.TestCase):
    def test_roundtrip_plain_gzip_alias(self):
        data = build_v5({1: b'{"a":1}', 7: gzip.compress(b"<html>hi</html>"), 9: b""}, {20: 7})
        p = pak.parse(data)
        self.assertEqual((p.version, p.encoding), (5, 1))
        self.assertEqual(p.get(1), (b'{"a":1}', ""))
        self.assertEqual(p.get(7), (b"<html>hi</html>", "gzip"))
        self.assertEqual(p.get(20), (b"<html>hi</html>", "gzip"))   # alias resolves
        self.assertEqual(p.raw(9), b"")
        self.assertEqual(p.ids(), [1, 7, 9, 20])

    def test_rejects_truncated_index(self):
        data = build_v5({1: b"x", 2: b"y"})
        with self.assertRaises(pak.PakError):
            pak.parse(data[:14])

    def test_rejects_out_of_bounds_offset(self):
        data = bytearray(build_v5({1: b"abc"}))
        struct.pack_into("<HI", data, 12 + 6, 0, len(data) + 100)   # end sentinel past EOF
        with self.assertRaises(pak.PakError):
            pak.parse(bytes(data))

    def test_rejects_unknown_version(self):
        with self.assertRaises(pak.PakError):
            pak.parse(struct.pack("<I", 9) + b"\0" * 20)

    def test_negative_control_wrong_alias_index(self):
        data = bytearray(build_v5({1: b"a"}, {5: 1}))
        struct.pack_into("<HH", data, 12 + 2 * 6, 5, 3)            # alias -> index 3 of 1
        with self.assertRaises(pak.PakError):
            pak.parse(bytes(data))


class ManifestTest(unittest.TestCase):
    def test_index_paths(self):
        idx = b'{"entries":[{"id":2,"path":"a/b.js"},{"id":3,"path":"c.html"}]}'
        p = pak.parse(build_v5({1: idx, 2: b"js", 3: b"<p>"}))
        self.assertEqual(pak.manifest_paths(p), {2: "a/b.js", 3: "c.html"})

    def test_rejects_traversal(self):
        for bad in ("../x", "/etc/passwd", "a/../../x"):
            idx = ('{"entries":[{"id":2,"path":"%s"}]}' % bad).encode()
            with self.assertRaises(pak.PakError, msg=bad):
                pak.manifest_paths(pak.parse(build_v5({1: idx, 2: b"x"})))

    def test_rejects_missing_resource(self):
        idx = b'{"entries":[{"id":9,"path":"x.js"}]}'
        with self.assertRaises(pak.PakError):
            pak.manifest_paths(pak.parse(build_v5({1: idx, 2: b"x"})))


if __name__ == "__main__":
    unittest.main()
