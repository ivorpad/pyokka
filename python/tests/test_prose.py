"""The sentence rules (``agent/prose.py``): what passes, what each failing line names, and the summary line."""

from __future__ import annotations

from pyokka_runtime.agent.prose import check, prose_warnings, reasons, units


def test_short_active_sentences_pass_and_code_spans_do_not_count():
    lines, total, passed = check("summary", "`subtotal` returns `0.0`. Line 13 catches the `TypeError` at `pricing.py:12`, e.g. for '1,249.00'.")
    assert lines == [] and (total, passed) == (2, 2)


def test_each_failing_sentence_is_named_with_its_reason():
    text = (
        "**What stop 1 shows:**\n"
        "The error was swallowed at line 13 and the subtotal of the whole order became 0.0, including the valid line, which nobody sees.\n"
        "| input | result |\n|---|---|\n"
        "- The parsing of the variable is simply wrong."
    )
    lines, total, passed = check("s5.text", text)
    assert total == 5 and passed == 0
    assert lines[0] == 's5.text: "What stop 1 shows:" (label with a colon)'
    assert "words; may be passive" in lines[1]
    assert lines[2].endswith("(table)") and lines[3].endswith("(table)")
    assert "filler: simply" in lines[4] and "variable, say value" in lines[4]


def test_domain_nouns_in_ing_are_allowed():
    assert reasons("The docstring names three formats, and the recording keeps the string.") == []
    assert reasons("The handling of the rows happens later.") == ["-ing as a noun: handling"]


def test_units_split_on_sentence_ends_only():
    assert units("Step 197 reads lines[0]. It fails. The value is '1,249.00'.") == ["Step 197 reads lines[0].", "It fails.", "The value is '1<d>249<d>00'."]


def test_the_summary_line_gives_the_pass_rate_and_the_target():
    fields = [("intro", "The run reads a file. It prints a total."), ("c1.text", "A list of rows is read by the loop and every row is parsed by the function before the total is written out.")]
    w = prose_warnings(fields)
    assert w[-1] == "prose: 2 of 3 sentences pass the sentence rules (67%); the rule asks for 80%"
    assert prose_warnings([("intro", "Short. Active. Fine.")])[-1] == "prose: 3 of 3 sentences pass the sentence rules (100%)"
    assert prose_warnings([("intro", "")]) == []
