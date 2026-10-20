"""What an agenda item's changed lines call in the repository (``review/uses.py``): the code the change relies on.

On 2026-10-20 the person asked for "the changed code, plus any code in the repo outside the change that it uses"
in the plan. Each item lists the callee with ``file:line``, and a callee that is itself on the agenda by its stop.
"""

from __future__ import annotations

from pathlib import Path

from pyokka_runtime.agent.review.debugger import plan_items
from pyokka_runtime.agent.review.render import plan_lines
from pyokka_runtime.agent.review.state import Review, change_diff
from pyokka_runtime.agent.review.uses import attach_uses, uses_text
from tests.test_review_actions import git

FILES = {
    "src/app/__init__.py": "",
    "src/app/receipt.py": "def valid(msg):\n    return msg.get('expiry', 0) > 0\n\n\ndef parse(raw):\n    return dict(raw)\n",
    "src/app/store.py": "def save(msg):\n    return msg\n",
    "src/app/ingest.py": (
        "import json\n"
        "from app import store\n"
        "from .receipt import parse\n"
        "\n"
        "\n"
        "def ingest(raw):\n"
        "    return raw\n"
        "\n"
        "\n"
        "class Queue:\n"
        "    def take(self, raw):\n"
        "        return raw\n"
        "\n"
        "    def ack(self, raw):\n"
        "        return raw\n"
    ),
}

HEAD_INGEST = (
    "import json\n"
    "from app import store\n"
    "from .receipt import parse\n"
    "from app.receipt import valid\n"
    "\n"
    "\n"
    "def ingest(raw):\n"
    "    msg = parse(json.loads(raw))\n"
    "    if not valid(msg):\n"
    "        return None\n"
    "    return store.save(msg)\n"
    "\n"
    "\n"
    "class Queue:\n"
    "    def take(self, raw):\n"
    "        return raw\n"
    "\n"
    "    def ack(self, raw):\n"
    "        self.take(raw)\n"
    "        return ingest(raw)\n"
)


def make(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "svc"
    for rel, text in FILES.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text, encoding="utf-8")
    git(repo.parent, "init", "-q", str(repo))
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
    (repo / "src/app/ingest.py").write_text(HEAD_INGEST, encoding="utf-8")
    (repo / "src/app/receipt.py").write_text(FILES["src/app/receipt.py"].replace("> 0", ">= 0"), encoding="utf-8")
    return repo, git(repo, "rev-parse", "HEAD")


def test_each_item_lists_the_repository_code_its_changed_lines_call(tmp_path):
    repo, base = make(tmp_path)
    plan = plan_items(str(repo), change_diff(str(repo), base).diff)
    assert attach_uses(plan["stops"], str(repo)) == 2
    by = {s["function"]: s for s in plan["stops"]}
    valid_stop = by["valid"]["n"]
    assert by["ingest"]["uses"] == [
        {"name": "parse", "file": "src/app/receipt.py", "line": 5},  # a relative import
        {"name": "valid", "file": "src/app/receipt.py", "line": 1, "stop": valid_stop},  # on the agenda: its stop
        {"name": "save", "file": "src/app/store.py", "line": 1},  # a module imported from its package
    ]  # json.loads is the standard library: left out
    assert by["ack"]["uses"] == [{"name": "Queue.take", "file": "src/app/ingest.py", "line": 15}, {"name": "ingest", "file": "src/app/ingest.py", "line": 7, "stop": by["ingest"]["n"]}]
    assert "uses" not in by["valid"]
    assert uses_text(by["ingest"]["uses"], room=2) == "uses: parse src/app/receipt.py:5, valid src/app/receipt.py:1 (stop %d), …" % valid_stop


def test_the_plan_prints_uses_under_the_item(tmp_path):
    repo, base = make(tmp_path)
    plan = plan_items(str(repo), change_diff(str(repo), base).diff)
    attach_uses(plan["stops"], str(repo))
    review = Review(str(tmp_path / "r"), {"plan": {"stops": plan["stops"]}, "shown": [], "skipped": []})
    lines = plan_lines(review)
    at = next(i for i, l in enumerate(lines) if " ingest " in l or l.rstrip().endswith("ingest") or "ingest  " in l)
    assert lines[at + 1].strip().startswith("uses: parse src/app/receipt.py:5")
