"""Fixture for the exceptions report (docs/PROTOCOL.md, "Exceptions report"): what generated code
does with exceptions, one shape per row the report must show.

A loop whose body raises three times into a bare ``except:`` (one row, count 3, broad); a specific
handler in a function (not broad); an exception that crosses a ``with`` and a ``finally`` before an
outer ``except Exception`` catches it (that clause is the handler, not the cleanup blocks it passed
through); a handler that re-raises (the outer clause caught it); ``contextlib.suppress`` (caught at
the ``with`` line); a library raising into user code (``libx``, stepped with library code on) and
one raised and caught inside the library (never reported); an exception caught by C code
(``getattr`` with a default over a raising ``__getattr__``: caught, nobody knows where); and an
uncaught ``ZeroDivisionError`` on the last line.
"""
import contextlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "site-packages"))
import libx  # noqa: E402


def lookup(table, key):
    return table[key]


def parse_amount(text):
    try:
        return int(text)
    except ValueError as exc:
        print("not a number:", exc)
        return 0


class Resource:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def load(path):
    try:
        with Resource():
            try:
                raise OSError("no such file: %s" % path)
            finally:
                cleaned = True
    except KeyError:
        return "never"
    except Exception:
        return None


def rethrow():
    try:
        raise RuntimeError("inner")
    except RuntimeError:
        raise


def third(items):
    with contextlib.suppress(IndexError):
        return items[3]
    return None


class Lazy:
    def __getattr__(self, name):
        raise AttributeError(name)


table = {"a": 1}
found = 0
for key in ("a", "b", "c", "d"):
    try:
        found += lookup(table, key)
    except:  # noqa: E722
        pass
amount = parse_amount("12x")
config = load("settings.toml")
try:
    rethrow()
except RuntimeError as err:
    outer = str(err)
picked = third([1, 2])
try:
    libx.unwrap(None)
except TypeError:
    unwrapped = None
safe = libx.safe_unwrap(None)
lazy = Lazy()
missing = [getattr(lazy, "x", None) for _ in range(2)]
total = found + amount
print(total / (total - total))
