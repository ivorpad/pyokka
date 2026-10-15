# The page lists the local imports before any run: imported.py, pkg/__init__.py, pkg/tools.py,
# pkg/helpers.py (through tools' relative import), pkg/sub/__init__.py and pkg/sub/deep.py.
import json
import os

import imported
from pkg import tools
from pkg.sub import deep

print(imported.greet("page"), tools.twice(3), deep.LEVEL, json.dumps(os.sep))
