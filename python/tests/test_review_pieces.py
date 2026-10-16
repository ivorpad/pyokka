"""The pieces review mode is built from: the ``--say`` naming rule, the tree hash and the unified-diff applier."""

from __future__ import annotations

import shutil

import pytest

from pyokka_runtime.agent.review import actions, patching
from pyokka_runtime.agent.review.state import tree_hash
from tests.test_review_actions import shop  # noqa: F401  pytest fixture


def test_names_a_value_rules():
    values = [("rate", "0.0"), ("tier", "'gold'"), ("lines", "[Line(sku='MON-27', qty=1)]")]
    assert actions.names_a_value("the rate is 0.0 here", values, None, 197) == "rate = 0.0"
    assert actions.names_a_value("a 10.0 discount", values, None, 197) is None  # 0.0 is not inside 10.0
    assert actions.names_a_value("tier is gold", values, None, 197) == "tier = 'gold'"  # quotes optional
    assert actions.names_a_value("lines = [ Line( sku = 'MON-27', qty = 1 ) ]", values, None, 197).startswith("lines = ")  # whitespace free
    assert actions.names_a_value("see step 197", [], None, 197) == "step 197" and actions.names_a_value("#197", [], None, 197) == "step 197"
    assert actions.names_a_value("1197 is not it", [], None, 197) is None
    assert actions.names_a_value("it became 1,249.00", [], {"a": "1249.0", "b": "'1,249.00'"}, 5) == "the fact's after text"
    assert actions.names_a_value("", values, None, 197) is None


def test_tree_hash_ignores_bytecode_and_sees_an_edit(shop, tmp_path):
    repo = tmp_path / "copy"
    shutil.copytree(shop.repo, repo)
    before = tree_hash(str(repo))
    (repo / "shopkit" / "__pycache__").mkdir()
    (repo / "shopkit" / "__pycache__" / "x.cpython-312.pyc").write_bytes(b"\x00")
    assert tree_hash(str(repo)) == before
    (repo / "notes.txt").write_text("untracked content\n")
    with_file = tree_hash(str(repo))
    assert with_file != before
    (repo / "notes.txt").write_text("other content\n")
    assert tree_hash(str(repo)) != with_file  # the content of an untracked file counts, not only its name


def test_apply_patch_offsets_a_hunk_creates_and_deletes_files_and_refuses_a_mismatch(tmp_path):
    root = tmp_path / "tree"
    root.mkdir()
    (root / "a.py").write_text("x = 1\ny = 2\nz = 3\n")
    (root / "gone.txt").write_text("bye\n")
    patch = (
        "--- a/a.py\n+++ b/a.py\n@@ -5,3 +5,3 @@\n x = 1\n-y = 2\n+y = 20\n z = 3\n"  # the header is off by four lines
        "--- /dev/null\n+++ b/new/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n"
        "--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"
    )
    assert patching.apply_patch(patch, str(root)) == ["a.py", "new/n.txt", "gone.txt"]
    assert (root / "a.py").read_text() == "x = 1\ny = 20\nz = 3\n" and (root / "new" / "n.txt").read_text() == "one\ntwo\n" and not (root / "gone.txt").exists()
    with pytest.raises(patching.PatchError, match=r"a.py: hunk @@ -1,1 \+1,1 @@ does not apply: expected 'nope'"):
        patching.apply_patch("--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-nope\n+yes\n", str(root))
    assert (root / "a.py").read_text() == "x = 1\ny = 20\nz = 3\n"  # nothing half-applied
    with pytest.raises(patching.PatchError, match="leaves the tree"):
        patching.apply_patch("--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n", str(root))
    with pytest.raises(patching.PatchError, match="no file change"):
        patching.apply_patch("just text\n", str(root))
