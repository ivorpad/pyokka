"""Executed with ``python -u -c`` through a container transport, before the NDJSON handshake."""
import base64
import gzip
import json
import os
import pathlib
import runpy
import sys
import tempfile


def main():
    if sys.version_info < (3, 12):
        raise RuntimeError("Pyokka transport needs Python 3.12 or newer")
    # The first line holds the extension's runtime. All subsequent bytes belong to serve.
    files = json.loads(gzip.decompress(base64.b64decode(sys.stdin.buffer.readline())))
    with tempfile.TemporaryDirectory(prefix="pyokka-transport-") as directory:
        root = pathlib.Path(directory).resolve()
        for name, content in files:
            target = root / name
            if not target.resolve().is_relative_to(root):
                raise ValueError("invalid path in Pyokka runtime bundle")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(content))
        # Spawned run children must import the same bundle, including on a spawn-only platform.
        sys.path.insert(0, directory)
        os.environ["PYTHONPATH"] = os.pathsep.join(filter(None, [directory, os.environ.get("PYTHONPATH", "")]))
        sys.argv = ["pyokka", "serve"]
        runpy.run_module("pyokka_runtime", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
