"""The page's import listing (`python -m pyokka_runtime _imports`): project files only, found the way
`import` finds them, and nothing a package provides, even from a .venv under the project root."""

import json
import os
import subprocess
import sys

from pyokka_runtime.imports import local_imports


def write(root, rel, text=""):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return os.path.realpath(path)


def test_lists_project_files_and_skips_the_stdlib_and_site_packages(tmp_path):
    site = tmp_path / ".venv" / "lib" / "python3.12" / "site-packages"
    entry = write(
        tmp_path,
        "main.py",
        "import os, json\nimport thirdparty\nimport helper\nfrom pkg import tools, CONSTANT\nfrom pkg.sub.deep import LEVEL\nimport missing_module\n",
    )
    helper = write(tmp_path, "helper.py", "def f():\n    import inner\n")
    inner = write(tmp_path, "inner.py")
    pkg_init = write(tmp_path, "pkg/__init__.py", "CONSTANT = 1\n")
    tools = write(tmp_path, "pkg/tools.py", "from .helpers import base\nfrom . import peer\n")
    helpers = write(tmp_path, "pkg/helpers.py")
    peer = write(tmp_path, "pkg/peer.py")
    sub_init = write(tmp_path, "pkg/sub/__init__.py")
    deep = write(tmp_path, "pkg/sub/deep.py", "LEVEL = 2\n")
    write(tmp_path, "unused.py")
    # a package installed into the project's own .venv: the import resolves there, and is left out
    write(site, "thirdparty/__init__.py", "from . import core\n")
    write(site, "thirdparty/core.py")

    found = local_imports(entry, str(tmp_path), path=[str(site)])

    assert sorted(found) == sorted([helper, inner, pkg_init, tools, helpers, peer, sub_init, deep])


def test_a_local_module_shadows_an_installed_one_as_at_run_time(tmp_path):
    entry = write(tmp_path, "main.py", "import pytest\n")
    assert local_imports(entry, str(tmp_path)) == []
    local = write(tmp_path, "pytest.py")
    assert local_imports(entry, str(tmp_path)) == [local]


def test_the_command_prints_the_list_as_json(tmp_path):
    entry = write(tmp_path, "main.py", "import helper\n")
    helper = write(tmp_path, "helper.py")
    out = subprocess.run([sys.executable, "-m", "pyokka_runtime", "_imports", entry, "--root", str(tmp_path)], capture_output=True, text=True, check=True, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__import__("pyokka_runtime").__file__))))
    assert json.loads(out.stdout) == [helper]
