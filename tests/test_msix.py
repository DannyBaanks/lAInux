"""Unit tests for lib/msix.py with synthetic packages (no upstream bytes)."""
import io
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MSIX = os.path.join(ROOT, "lib", "msix.py")
MANIFEST = b'<Package><Identity Name="Test.App" Version="1.2.3.0" ProcessorArchitecture="x64" /></Package>'


def make_msix(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("AppxManifest.xml", MANIFEST)
        z.writestr("AppxBlockMap.xml", b"<x/>")
        z.writestr("[Content_Types].xml", b"<x/>")
        z.writestr("AppxMetadata/CodeIntegrity.cat", b"x")
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


def run(*args):
    return subprocess.run([sys.executable, "-I", MSIX, *args], capture_output=True, text=True)


class MsixTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, data):
        p = os.path.join(self.d, name)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def test_percent_encoded_names_are_decoded(self):
        pkg = self.write("a.msix", make_msix({"resources/node_modules/%40scope/mod/index.js": b"ok"}))
        out = os.path.join(self.d, "out")
        r = run("extract", pkg, out)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(os.path.join(out, "resources/node_modules/@scope/mod/index.js"), "rb") as f:
            self.assertEqual(f.read(), b"ok")
        self.assertFalse(os.path.exists(os.path.join(out, "resources/node_modules/%40scope")))

    def test_metadata_is_dropped_manifest_kept(self):
        pkg = self.write("a.msix", make_msix({"Main.exe": b"MZ"}))
        out = os.path.join(self.d, "out")
        self.assertEqual(run("extract", pkg, out).returncode, 0)
        self.assertEqual(sorted(os.listdir(out)), ["AppxManifest.xml", "Main.exe"])

    def test_bundle_picks_requested_arch(self):
        bundle = io.BytesIO()
        with zipfile.ZipFile(bundle, "w") as z:
            z.writestr("App-arm64.msix", make_msix({"arch.txt": b"arm64"}))
            z.writestr("App-x64.msix", make_msix({"arch.txt": b"x64"}))
            z.writestr("AppxMetadata/AppxBundleManifest.xml", b"<x/>")
        pkg = self.write("a.msixbundle", bundle.getvalue())
        out = os.path.join(self.d, "out")
        self.assertEqual(run("extract", pkg, out, "--arch", "x64").returncode, 0)
        with open(os.path.join(out, "arch.txt"), "rb") as f:
            self.assertEqual(f.read(), b"x64")
        r = run("identity", pkg)
        self.assertIn('Version="1.2.3.0"', r.stdout)

    def test_path_traversal_is_refused(self):
        for evil in ("../escape.txt", "a/%2e%2e/%2e%2e/escape.txt", "/abs.txt"):
            pkg = self.write("evil.msix", make_msix({evil: b"x"}))
            out = os.path.join(self.d, "out-" + str(abs(hash(evil))))
            r = run("extract", pkg, out)
            self.assertNotEqual(r.returncode, 0, evil)
            self.assertFalse(os.path.exists(os.path.join(self.d, "escape.txt")), evil)


if __name__ == "__main__":
    unittest.main()
