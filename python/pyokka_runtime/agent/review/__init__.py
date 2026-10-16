"""Review mode: ``pyokka review`` and the ``pyokka_review`` MCP tool (``docs/design/review-mode.md``).

A code review as a guided debug session whose sequence the tool owns: ``start`` records the base
and the head tree, compares the two runs and plans the stops; ``stop N --say TEXT`` shows one and
refuses an explanation that names none of its values; ``ask`` is an unplanned stop; ``try`` runs
a reproduction in the Scratchpad's sandbox; ``finding add`` needs a step and a reproduction;
``fix`` applies a patch to a copy of head and records it; ``report`` re-runs every reproduction
before it prints. Every answer starts with the review's header line and ends with ``next:``.

The review is a conversation: one stop per call, then the person has the floor; the next ``stop``
needs ``--go-on`` (they said next), while ``ask``, ``look`` and ``try`` answer them meanwhile and
``skip`` sets an agenda item aside with their reason.

Modules: ``state`` (the directory, ``review.json``, the header and ``next:``), ``start``,
``actions`` (stop, ask, try, the dispatch), ``agenda`` (skip, look, state), ``findings``
(finding add), ``fixes`` (fix, report), ``patching`` (a unified-diff applier), ``render``,
``parser`` (the argparse words), ``tool`` (the MCP tool and the prompt). Stream A2's ``plan``,
``surfaces`` and ``tryrun`` are imported where they are called.
"""
