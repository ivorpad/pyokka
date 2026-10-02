"""Debugger e2e target: run with `python -m <pkg>.server --port N`."""

import sys

from . import NAME


def port_of(argv):
    if "--port" in argv:
        return int(argv[argv.index("--port") + 1])
    return 0


port = port_of(sys.argv[1:])
label = "%s on %d" % (NAME, port)
print(label)
