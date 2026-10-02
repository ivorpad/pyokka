"""`names.py`: the scanner behind a statement node's `targets` and `reads` (docs/PROTOCOL.md, "statement")."""

from __future__ import annotations

from pyokka_runtime.agent.names import loop_names, names_of, strip_code, strip_comments


def test_plain_and_tuple_and_annotated_targets():
    assert names_of(['x = 1']) == (["x"], [])
    assert names_of(['name, date, people = text.split("|")']) == (["name", "date", "people"], ["text"])
    assert names_of(["total: int = start + 1"]) == (["total"], ["int", "start"])
    assert names_of(["a = b = 1"]) == (["a"], ["b"])


def test_augmented_assignment_keeps_the_target_as_a_read():
    assert names_of(["count += 1"]) == (["count"], ["count"])
    assert names_of(["total -= helper.double(i)"]) == (["total"], ["total", "helper", "i"])
    assert names_of(["x **= 2"]) == (["x"], ["x"])
    assert names_of(["x //= y"]) == (["x"], ["x", "y"])


def test_attribute_subscript_and_starred_targets_assign_no_name():
    assert names_of(["self.name = name"]) == ([], ["self", "name"])
    assert names_of(["d[k] = v"]) == ([], ["d", "k", "v"])
    assert names_of(["first, *rest = items"]) == ([], ["first", "rest", "items"])
    assert names_of(["(a, b) = pair"]) == ([], ["a", "b", "pair"])


def test_comparisons_and_walrus_are_not_assignments():
    assert names_of(["x == y"]) == ([], ["x", "y"])
    assert names_of(["assert a <= b and c != d and e >= f"]) == ([], ["a", "b", "c", "d", "e", "f"])
    assert names_of(["print((n := len(items)))"]) == ([], ["print", "n", "len", "items"])


def test_keyword_arguments_are_not_reads_but_a_top_level_assignment_is():
    assert names_of(["event = parse_event(text, year=2026)"]) == (["event"], ["parse_event", "text"])
    assert names_of(["f(a, b=c, d=e == g)"]) == ([], ["f", "a", "c", "e", "g"])
    assert names_of(["result = compute(alpha=alpha, beta=beta)"]) == (["result"], ["compute", "alpha", "beta"])


def test_attribute_names_and_keywords_are_dropped():
    assert names_of(["label = shout(event.name)"]) == (["label"], ["shout", "event"])
    assert names_of(["return word.upper()"]) == ([], ["word"])
    assert names_of(["handled = True"]) == (["handled"], [])
    assert names_of(["x = a if b is not None else lambda n: n * 2"]) == (["x"], ["a", "b", "n"])
    assert names_of(["value = 10_000 + 0x1f + 1e5"]) == (["value"], [])


def test_string_literals_are_opaque_except_f_string_expressions():
    assert names_of(['summary = f"{label} with {count} people on {event.date}"']) == (["summary"], ["label", "count", "event"])
    assert names_of(['print(f"Participant: {person}")']) == ([], ["print", "person"])
    assert names_of(['msg = "hello " + name']) == (["msg"], ["name"])
    assert names_of([r'path = rf"C:\\temp\\{drive} {{x}}"']) == (["path"], ["drive"])
    # the `!r` conversion is appended with the expression (the contract says so): `r` shows up as a read
    assert names_of(['s = f"{{not}} {a!r} {b:>{width}} {{{c}}}"']) == (["s"], ["a", "r", "b", "width", "c"])
    assert names_of(["quoted = 'it\\'s # not a comment'  # but this is x"]) == (["quoted"], [])
    assert names_of(['text = "fair|Sep 16|alice,bob"  # the \'|\' separates the fields']) == (["text"], [])


def test_triple_quotes_and_prefixes_across_lines():
    lines = ['doc = """first # line', "second {not} line", '""" + tail']
    assert names_of(lines) == (["doc"], ["tail"])
    assert strip_code(lines).split() == ["doc", "=", "+", "tail"]
    lines = ['pattern = rb"""a', 'b"""', 'other = f"""{x}', '{y}"""']
    assert names_of(lines) == (["pattern"], ["other", "x", "y"])
    assert names_of(["message = ('one'", "  'two' + name)"]) == (["message"], ["name"])


def test_multi_line_call_with_keyword_arguments_and_f_strings():
    lines = ["event = Event(", "    name=name,", '    date=f"{date} {year}",  # the year', "    participants=participants,", ")"]
    assert names_of(lines) == (["event"], ["Event", "name", "date", "year", "participants"])
    assert strip_comments(lines) == ["event = Event(", "    name=name,", '    date=f"{date} {year}",  ', "    participants=participants,", ")"]


def test_a_hash_inside_a_string_is_not_a_comment():
    assert strip_comments(['x = "a # b"  # c']) == ['x = "a # b"  ']
    assert strip_code(['x = "a # b"  # c']) == "x =    "
    assert strip_comments(["y = 1  # x = 2"]) == ["y = 1  "]


def test_loop_headers():
    assert loop_names("person in event.participants") == (["person"], ["event"])
    assert loop_names("a, b in pairs") == (["a", "b"], ["pairs"])
    assert loop_names("i, (x, y) in enumerate(points)") == (["i", "x", "y"], ["enumerate", "points"])
    assert loop_names("i in range(3)") == (["i"], ["range"])
