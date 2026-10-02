"""Recording debug e2e target: reads what the launch handed it, then loops."""

import os
import sys

argv = sys.argv[1:]
flag = os.environ.get("PYOKKA_E2E_RECORDING", "")
total = 0
for i in range(3):
    total += i
print(argv, flag, total)
