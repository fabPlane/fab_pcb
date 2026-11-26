"""Exercise real and corrupted evidence with both Python assertion modes."""

from pathlib import Path
import subprocess
import sys
import unittest

VERIFIER = Path(__file__).with_name("verify-manifests.py")


class ManifestChecks(unittest.TestCase):
    def test_real_evidence(self):
        for mode in ([], ["-O"]):
            with self.subTest(mode=mode):
                subprocess.run([sys.executable, *mode, str(VERIFIER)], check=True)

    def test_corruption(self):
        # Load the actual function in a fresh interpreter so -O covers the
        # verifier itself. Temporary members never touch retained evidence.
        script = r'''import hashlib, pathlib, runpy, sys, tempfile
verify = runpy.run_path(sys.argv[1])["verify"]
with tempfile.TemporaryDirectory() as tmp:
    directory = pathlib.Path(tmp)
    member = directory / "member.bin"
    member.write_bytes(b"recorded")
    record = {"sha256": hashlib.sha256(b"recorded").hexdigest(), "bytes": 8}
    verify(directory, {"nested": {"member.bin": record}})
    if sys.argv[2] == "checksum":
        member.write_bytes(b"modified")
    elif sys.argv[2] == "size":
        record["bytes"] = 9
    else:
        member.unlink()
    try:
        verify(directory, {"nested": {"member.bin": record}})
    except ValueError:
        pass
    else:
        raise RuntimeError("corrupted evidence accepted")
'''
        for mode in ([], ["-O"]):
            for corruption in ("checksum", "size", "missing"):
                with self.subTest(mode=mode, corruption=corruption):
                    subprocess.run(
                        [sys.executable, *mode, "-c", script, str(VERIFIER), corruption],
                        check=True,
                    )


if __name__ == "__main__":
    unittest.main()
