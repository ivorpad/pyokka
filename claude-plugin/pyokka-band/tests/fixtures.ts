// Written by scripts/band-fixtures.py from what the pyokka CLI printed. Do not edit by hand:
// run the script again when the CLI's JSON changes. Paths read /work/<file>.

// `context --json` at step 64 of invoices.py: the TypeError that subtotal swallows
export const CONTEXT_64 = {
  "step": 64,
  "count": 81,
  "location": {
    "file": "/work/invoices.py",
    "line": 34,
    "col": 8,
    "function": "subtotal",
    "fileId": 1
  },
  "stale": false,
  "staleFiles": [],
  "stack": [
    {
      "file": "/work/invoices.py",
      "line": 34,
      "function": "subtotal",
      "step": 64
    },
    {
      "file": "/work/invoices.py",
      "line": 42,
      "function": "invoice_total",
      "step": 61
    },
    {
      "file": "/work/invoices.py",
      "line": 47,
      "function": "main",
      "step": 52
    },
    {
      "file": "/work/invoices.py",
      "line": 53,
      "function": "<module>",
      "step": 2
    }
  ],
  "block": {
    "file": "/work/invoices.py",
    "function": "subtotal",
    "scopeId": 12,
    "firstStep": 62,
    "lastStep": 65,
    "lines": [
      {
        "line": 32,
        "text": "def subtotal(items):",
        "step": 62
      },
      {
        "line": 33,
        "text": "    try:",
        "step": 63
      },
      {
        "line": 34,
        "text": "        return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)",
        "step": 64,
        "current": true
      },
      {
        "line": 37,
        "text": "        return 0.0",
        "step": 65
      }
    ],
    "totalLines": 4,
    "capped": false,
    "returned": "0.0"
  },
  "calls": [],
  "values": [
    {
      "line": 33,
      "file": "/work/invoices.py",
      "context": "items",
      "text": "[{'qty': 1, 'sku': 'MON-27', 'unit_price': '1,299.00'}, {'qty': 3, 'sku': 'CBL-02', 'unit_price': 7.5}]",
      "step": 63,
      "hit": null,
      "kind": "local",
      "runtimeKey": null
    }
  ],
  "valuesTotal": 1,
  "valuesCapped": false,
  "coverage": {
    "notRun": []
  },
  "moves": {
    "into": 65,
    "over": 65,
    "out": 78,
    "back": 63,
    "backOver": 63,
    "backOut": 61
  },
  "errors": [
    {
      "line": 34,
      "type": "TypeError",
      "message": "unsupported operand type(s) for +: 'int' and 'str'",
      "step": 64,
      "handled": true
    }
  ],
  "flags": [
    "error"
  ]
}

// `context --json` at step 29 of invoices.py: parse_price returns the text '1,299.00'
export const CONTEXT_29 = {
  "step": 29,
  "count": 81,
  "location": {
    "file": "/work/invoices.py",
    "line": 18,
    "col": 4,
    "function": "parse_price",
    "fileId": 1
  },
  "stale": false,
  "staleFiles": [],
  "stack": [
    {
      "file": "/work/invoices.py",
      "line": 18,
      "function": "parse_price",
      "step": 29
    },
    {
      "file": "/work/invoices.py",
      "line": 28,
      "function": "parse_orders",
      "step": 26
    },
    {
      "file": "/work/invoices.py",
      "line": 46,
      "function": "main",
      "step": 4
    },
    {
      "file": "/work/invoices.py",
      "line": 53,
      "function": "<module>",
      "step": 2
    }
  ],
  "block": {
    "file": "/work/invoices.py",
    "function": "parse_price",
    "scopeId": 5,
    "firstStep": 27,
    "lastStep": 29,
    "lines": [
      {
        "line": 15,
        "text": "def parse_price(raw):",
        "step": 27
      },
      {
        "line": 16,
        "text": "    text = raw.strip('\"')",
        "step": 28
      },
      {
        "line": 17,
        "text": "    # numbers only: \"49.90\" -> 49.9; anything else is kept as text for the audit log",
        "step": null
      },
      {
        "line": 18,
        "text": "    return float(text) if text.replace(\".\", \"\", 1).isdigit() else text",
        "step": 29,
        "current": true
      }
    ],
    "totalLines": 4,
    "capped": false,
    "returned": "'1,299.00'"
  },
  "calls": [],
  "values": [
    {
      "line": 16,
      "file": "/work/invoices.py",
      "context": "raw",
      "text": "'\"1,299.00\"'",
      "step": 28,
      "hit": null,
      "kind": "local",
      "runtimeKey": null
    },
    {
      "line": 18,
      "file": "/work/invoices.py",
      "context": "text",
      "text": "'1,299.00'",
      "step": 29,
      "hit": null,
      "kind": "local",
      "runtimeKey": null
    }
  ],
  "valuesTotal": 2,
  "valuesCapped": false,
  "coverage": {
    "notRun": []
  },
  "moves": {
    "into": 30,
    "over": 30,
    "out": 30,
    "back": 28,
    "backOver": 28,
    "backOut": 26
  },
  "errors": [],
  "flags": []
}

// `context --json` at step 64 after invoices.py changed on disk
export const CONTEXT_STALE = {
  "step": 64,
  "count": 81,
  "location": {
    "file": "/work/stale/invoices.py",
    "line": 34,
    "col": 8,
    "function": "subtotal",
    "fileId": 1
  },
  "stale": true,
  "staleFiles": [
    "/work/stale/invoices.py"
  ],
  "stack": [
    {
      "file": "/work/stale/invoices.py",
      "line": 34,
      "function": "subtotal",
      "step": 64
    },
    {
      "file": "/work/stale/invoices.py",
      "line": 42,
      "function": "invoice_total",
      "step": 61
    },
    {
      "file": "/work/stale/invoices.py",
      "line": 47,
      "function": "main",
      "step": 52
    },
    {
      "file": "/work/stale/invoices.py",
      "line": 53,
      "function": "<module>",
      "step": 2
    }
  ],
  "block": {
    "file": "/work/stale/invoices.py",
    "function": "subtotal",
    "scopeId": 12,
    "firstStep": 62,
    "lastStep": 65,
    "lines": [
      {
        "line": 32,
        "text": "def subtotal(items):",
        "step": 62
      },
      {
        "line": 33,
        "text": "    try:",
        "step": 63
      },
      {
        "line": 34,
        "text": "        return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)",
        "step": 64,
        "current": true
      },
      {
        "line": 37,
        "text": "        return 0.0",
        "step": 65
      }
    ],
    "totalLines": 4,
    "capped": false,
    "returned": "0.0"
  },
  "calls": [],
  "values": [
    {
      "line": 33,
      "file": "/work/stale/invoices.py",
      "context": "items",
      "text": "[{'qty': 1, 'sku': 'MON-27', 'unit_price': '1,299.00'}, {'qty': 3, 'sku': 'CBL-02', 'unit_price': 7.5}]",
      "step": 63,
      "hit": null,
      "kind": "local",
      "runtimeKey": null
    }
  ],
  "valuesTotal": 1,
  "valuesCapped": false,
  "coverage": {
    "notRun": []
  },
  "moves": {
    "into": 65,
    "over": 65,
    "out": 78,
    "back": 63,
    "backOver": 63,
    "backOut": 61
  },
  "errors": [
    {
      "line": 34,
      "type": "TypeError",
      "message": "unsupported operand type(s) for +: 'int' and 'str'",
      "step": 64,
      "handled": true
    }
  ],
  "flags": [
    "error"
  ]
}

// `exceptions --json` of invoices.py: one TypeError, caught
export const EXCEPTIONS_CAUGHT = {
  "count": 81,
  "file": "/work/invoices.py",
  "exitCode": 0,
  "stale": false,
  "staleFiles": [],
  "total": 1,
  "raises": 1,
  "uncaught": 0,
  "caught": 1,
  "broad": 0,
  "rows": [
    {
      "id": "x0",
      "kind": "caught",
      "errorType": "TypeError",
      "message": "unsupported operand type(s) for +: 'int' and 'str'",
      "count": 1,
      "step": 64,
      "lastStep": 64,
      "raisedAt": {
        "file": "/work/invoices.py",
        "line": 34,
        "function": "subtotal",
        "fileId": 1,
        "rid": 19
      },
      "handledAt": {
        "file": "/work/invoices.py",
        "line": 35,
        "function": "subtotal",
        "fileId": 1,
        "rid": 18,
        "broad": false
      }
    }
  ]
}

// `exceptions --json` of crash.py: one KeyError that ends the run
export const EXCEPTIONS_UNCAUGHT = {
  "count": 7,
  "file": "/work/crash.py",
  "exitCode": 1,
  "stale": false,
  "staleFiles": [],
  "total": 1,
  "raises": 1,
  "uncaught": 1,
  "caught": 0,
  "broad": 0,
  "rows": [
    {
      "id": "x0",
      "kind": "uncaught",
      "errorType": "KeyError",
      "message": "'Ben'",
      "count": 1,
      "step": 6,
      "lastStep": 6,
      "raisedAt": {
        "file": "/work/crash.py",
        "line": 2,
        "function": "tier_of",
        "fileId": 1,
        "rid": 2
      },
      "handledAt": null
    }
  ]
}

// `origin --json` at step 64 of invoices.py: where the text '1,299.00' came from
export const ORIGIN_64 = {
  "step": 64,
  "file": "/work/invoices.py",
  "fileId": 1,
  "line": 34,
  "function": "subtotal",
  "scopeId": 12,
  "statement": "return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)",
  "recordedLocals": true,
  "links": [
    {
      "step": 64,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 34,
      "function": "subtotal",
      "scopeId": 12,
      "expr": "items[0][\"unit_price\"]",
      "how": "read",
      "certainty": "recorded",
      "text": "'1,299.00'",
      "type": "str",
      "note": "the failing statement reads it",
      "statement": "return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)"
    },
    {
      "step": 61,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 42,
      "function": "invoice_total",
      "scopeId": 11,
      "expr": "order[\"items\"][0][\"unit_price\"]",
      "how": "argument",
      "certainty": "recorded",
      "text": "'1,299.00'",
      "type": "str",
      "note": "items of subtotal",
      "statement": "return round(subtotal(order[\"items\"]) * (1 - rate), 2)"
    },
    {
      "step": 52,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 47,
      "function": "main",
      "scopeId": 1,
      "expr": "order[\"items\"][0][\"unit_price\"]",
      "how": "argument",
      "certainty": "recorded",
      "text": "'1,299.00'",
      "type": "str",
      "note": "order of invoice_total",
      "statement": "totals = {name: invoice_total(order) for name, order in orders.items()}"
    },
    {
      "step": 26,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 28,
      "function": "parse_orders",
      "scopeId": 2,
      "expr": "parse_price(price)",
      "how": "element",
      "certainty": "inferred",
      "text": "'1,299.00'",
      "type": "str",
      "note": "put under key 'unit_price' here; matched by key and value text, the recording has no object identity",
      "statement": "order[\"items\"].append({\"sku\": sku, \"qty\": int(qty), \"unit_price\": parse_price(price)})"
    },
    {
      "step": 29,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 18,
      "function": "parse_price",
      "scopeId": 5,
      "expr": "return float(text) if text.replace(\".\", \"\", 1).isdigit() else text",
      "how": "return",
      "certainty": "recorded",
      "text": "'1,299.00'",
      "type": "str",
      "note": "parse_price returned it",
      "statement": "return float(text) if text.replace(\".\", \"\", 1).isdigit() else text",
      "root": true
    },
    {
      "step": 28,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 16,
      "function": "parse_price",
      "scopeId": 5,
      "expr": "text",
      "how": "assigned",
      "certainty": "inferred",
      "text": "'1,299.00'",
      "type": "str",
      "note": "the branch whose value matches",
      "statement": "text = raw.strip('\"')"
    },
    {
      "step": 26,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 28,
      "function": "parse_orders",
      "scopeId": 2,
      "expr": "price",
      "how": "argument",
      "certainty": "inferred",
      "text": "'\"1,299.00\"'",
      "type": "str",
      "note": "raw of parse_price; the one input of raw.strip('\"')",
      "statement": "order[\"items\"].append({\"sku\": sku, \"qty\": int(qty), \"unit_price\": parse_price(price)})"
    },
    {
      "step": 24,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 26,
      "function": "parse_orders",
      "scopeId": 2,
      "expr": "price",
      "how": "assigned",
      "certainty": "recorded",
      "text": "'\"1,299.00\"'",
      "type": "str",
      "statement": "customer, tier, sku, qty, price = row.split(\",\", 4)"
    },
    {
      "step": 23,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 24,
      "function": "parse_orders",
      "scopeId": 2,
      "expr": "row",
      "how": "element",
      "certainty": "inferred",
      "text": "'Ben,silver,MON-27,1,\"1,299.00\"'",
      "type": "str",
      "note": "loop variable over rows; the one input of row.split(\",\", 4)",
      "statement": "for row in rows:"
    },
    {
      "step": 6,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 22,
      "function": "parse_orders",
      "scopeId": 2,
      "expr": "rows",
      "how": "assigned",
      "certainty": "recorded",
      "text": "['Ana,gold,KB-01,2,49.90', 'Ana,gold,MS-07,1,19.90', 'Ben,silver,MON-27,1,\"1,299.00\"', 'Ben,silver,CBL-02,3,7.50', 'Car…(+46 chars)",
      "type": "list",
      "statement": "header, *rows = csv_text.strip().splitlines()",
      "truncated": true,
      "length": 165
    },
    {
      "step": 4,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 46,
      "function": "main",
      "scopeId": 1,
      "expr": "ORDERS_CSV",
      "how": "argument",
      "certainty": "inferred",
      "text": "'customer,tier,sku,qty,unit_price\\nAna,gold,KB-01,2,49.90\\...02,3,7.50\\nCaro,,KB-01,1,49.90\\nDani,gold,HUB-04,2,34.00\\n'…(+69 chars)",
      "type": "str",
      "note": "csv_text of parse_orders; the one input of csv_text.strip().splitlines()",
      "statement": "orders = parse_orders(ORDERS_CSV)",
      "truncated": true,
      "length": 189
    },
    {
      "step": 0,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 6,
      "function": "<module>",
      "scopeId": 0,
      "expr": "Ben,silver,MON-27,1,\"1,299.00\"",
      "how": "literal",
      "certainty": "text match",
      "text": "'Ben,silver,MON-27,1,\"1,299.00\"'",
      "type": "str",
      "note": "the line of the literal ORDERS_CSV that holds it",
      "statement": "ORDERS_CSV = \"\"\"customer,tier,sku,qty,unit_price"
    }
  ],
  "root": {
    "index": 4,
    "step": 29,
    "reason": "parse_price returned a str here; its other 5 calls returned a float",
    "evidence": "siblings"
  },
  "truncated": false,
  "error": {
    "type": "TypeError",
    "message": "unsupported operand type(s) for +: 'int' and 'str'",
    "caught": true
  },
  "value": {
    "expr": "items[0][\"unit_price\"]",
    "text": "'1,299.00'",
    "type": "str",
    "chosen": "the str operand"
  },
  "need": "a number",
  "end": "a literal in the source",
  "stale": false,
  "staleFiles": []
}

// `origin --json` at step 64 of invoices.py for `items`: a list filled in place, root not known
export const ORIGIN_UNKNOWN = {
  "step": 64,
  "file": "/work/invoices.py",
  "fileId": 1,
  "line": 34,
  "function": "subtotal",
  "scopeId": 12,
  "statement": "return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)",
  "recordedLocals": true,
  "links": [
    {
      "step": 64,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 34,
      "function": "subtotal",
      "scopeId": 12,
      "expr": "items",
      "how": "read",
      "certainty": "recorded",
      "text": "[{'qty': 1, 'sku': 'MON-27', 'unit_price': '1,299.00'}, {'qty': 3, 'sku': 'CBL-02', 'unit_price': 7.5}]",
      "type": "list",
      "note": "the failing statement reads it",
      "statement": "return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)"
    },
    {
      "step": 61,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 42,
      "function": "invoice_total",
      "scopeId": 11,
      "expr": "order[\"items\"]",
      "how": "argument",
      "certainty": "recorded",
      "text": "[{'qty': 1, 'sku': 'MON-27', 'unit_price': '1,299.00'}, {'qty': 3, 'sku': 'CBL-02', 'unit_price': 7.5}]",
      "type": "list",
      "note": "items of subtotal",
      "statement": "return round(subtotal(order[\"items\"]) * (1 - rate), 2)"
    },
    {
      "step": 52,
      "file": "/work/invoices.py",
      "fileId": 1,
      "line": 47,
      "function": "main",
      "scopeId": 1,
      "expr": "order[\"items\"]",
      "how": "argument",
      "certainty": "recorded",
      "text": "[{'qty': 1, 'sku': 'MON-27', 'unit_price': '1,299.00'}, {'qty': 3, 'sku': 'CBL-02', 'unit_price': 7.5}]",
      "type": "list",
      "note": "order of invoice_total",
      "statement": "totals = {name: invoice_total(order) for name, order in orders.items()}"
    }
  ],
  "root": null,
  "truncated": false,
  "error": {
    "type": "TypeError",
    "message": "unsupported operand type(s) for +: 'int' and 'str'",
    "caught": true
  },
  "value": {
    "expr": "items",
    "text": "[{'qty': 1, 'sku': 'MON-27', 'unit_price': '1,299.00'}, {'qty': 3, 'sku': 'CBL-02', 'unit_price': 7.5}]",
    "type": "list",
    "chosen": "named"
  },
  "end": "no statement before #52 put this value under key 'items' with the same text; the container was probably filled in place after it was made, which the recording does not tie to a statement",
  "rootUnknown": "the chain stops before a statement that made the value, so its root is not known",
  "stale": false,
  "staleFiles": []
}

// `suspects --json` of invoices.py (worktree-bugs, WIP)
export const SUSPECTS = {
  "suspects": 1,
  "run": {
    "file": "invoices.py",
    "steps": 81,
    "exitCode": 0
  },
  "goal": {
    "text": "the last 2 printed lines",
    "steps": [
      79,
      80
    ]
  },
  "total": 2,
  "shown": 2,
  "findings": [
    {
      "kind": "caught-exception",
      "step": 64,
      "line": 34,
      "confidence": "medium",
      "reason": "TypeError: unsupported operand type(s) for +: 'int' and 'str' raised in subtotal (invoices.py:34) and caught at invoices.py:35 which does not re-raise, so the run went on without that result",
      "evidence": [
        {
          "name": "raised",
          "text": "TypeError: unsupported operand type(s) for +: 'int' and 'str'",
          "step": 64
        },
        {
          "name": "caught at",
          "text": "invoices.py:35"
        }
      ],
      "count": 1,
      "onGoalChain": false,
      "score": 2.0,
      "id": "f1",
      "rank": 1,
      "file": "invoices.py",
      "function": "subtotal",
      "statement": "return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)",
      "why": {
        "statement": "return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)",
        "reads": [
          {
            "name": "items",
            "text": "[{'qty': 1, 'sku': 'MON-27', 'unit_price': '1,299.00'}, {'qty': 3, 'sku': 'CBL-…",
            "step": 62
          }
        ]
      }
    },
    {
      "kind": "dead-store",
      "step": 6,
      "line": 22,
      "confidence": "low",
      "reason": "header = 'customer,tier,sku,qty,unit_price' at invoices.py:22 in parse_orders: unpacked and never read",
      "evidence": [
        {
          "name": "header",
          "text": "'customer,tier,sku,qty,unit_price'",
          "step": 6
        }
      ],
      "onGoalChain": false,
      "score": 1.0,
      "id": "f2",
      "rank": 2,
      "file": "invoices.py",
      "function": "parse_orders",
      "statement": "header, *rows = csv_text.strip().splitlines()",
      "why": {
        "statement": "header, *rows = csv_text.strip().splitlines()",
        "reads": [
          {
            "name": "csv_text",
            "text": "'customer,tier,sku,qty,unit_price\\nAna,gold,KB-01,2,49.90\\...02,3,7.50\\nCaro,,K…",
            "step": 5
          }
        ]
      }
    }
  ],
  "detectorErrors": [],
  "timing": {
    "ms": 10,
    "modelMs": 0,
    "detectMs": 6
  }
}

// `context --live --json` at a plain debug pause (no recording): the breakpoint on invoices.py:34, Ana's call
export const PAUSED_SUBTOTAL = {
  "step": 58,
  "location": {
    "file": "/work/invoices.py",
    "line": 34,
    "col": 0,
    "function": "subtotal",
    "fileId": 1
  },
  "stale": false,
  "stack": [
    {
      "file": "/work/invoices.py",
      "line": 34,
      "function": "subtotal",
      "frameId": 0
    },
    {
      "file": "/work/invoices.py",
      "line": 42,
      "function": "invoice_total",
      "frameId": 1
    },
    {
      "file": "/work/invoices.py",
      "line": 47,
      "function": "main",
      "frameId": 2
    },
    {
      "file": "/work/invoices.py",
      "line": 53,
      "function": "<module>",
      "frameId": 3
    }
  ],
  "block": {
    "file": "/work/invoices.py",
    "function": "subtotal",
    "scopeId": 10,
    "lines": [
      {
        "line": 32,
        "text": "def subtotal(items):"
      },
      {
        "line": 33,
        "text": "    try:"
      },
      {
        "line": 34,
        "text": "        return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)",
        "current": true
      },
      {
        "line": 35,
        "text": "    except (KeyError, TypeError):"
      },
      {
        "line": 36,
        "text": "        # a malformed line should not stop the month's report"
      },
      {
        "line": 37,
        "text": "        return 0.0"
      }
    ]
  },
  "values": [],
  "errors": [],
  "output": {
    "text": "",
    "since": "start",
    "lines": 0,
    "earlier": 0,
    "truncated": false,
    "seq": 0
  },
  "modified": false,
  "thread": {
    "name": "MainThread",
    "ident": 8362385792
  },
  "recording": false,
  "paused": {
    "step": 58,
    "rid": 19,
    "fileId": 1,
    "line": 34,
    "scopeId": 10,
    "depth": 3,
    "reason": "breakpoint",
    "stack": [
      {
        "frameId": 0,
        "name": "subtotal",
        "fileId": 1,
        "line": 34,
        "rid": 19,
        "scopeId": 10
      },
      {
        "frameId": 1,
        "name": "invoice_total",
        "fileId": 1,
        "line": 42,
        "rid": 24,
        "scopeId": 9
      },
      {
        "frameId": 2,
        "name": "main",
        "fileId": 1,
        "line": 47,
        "rid": 27,
        "scopeId": 1
      },
      {
        "frameId": 3,
        "name": "<module>",
        "fileId": 1,
        "line": 53,
        "rid": 33,
        "scopeId": 0
      }
    ],
    "breakpoint": {
      "path": "/work/invoices.py",
      "line": 34,
      "rid": 19,
      "fileId": 1,
      "resolvedLine": 34,
      "file": "_band_e2e/invoices.py"
    },
    "thread": {
      "name": "MainThread",
      "ident": 8362385792
    },
    "file": "/work/invoices.py"
  },
  "locals": [
    {
      "name": "items",
      "text": "[{'qty': 2, 'sku': 'KB-01', 'unit_price': 49.9}, {'qty': 1, 'sku': 'MS-07', 'unit_price': 19.9}]",
      "type": "list",
      "length": 2
    }
  ]
}

// `step --live --over --json` from there: the breakpoint again, Ben's call with the text '1,299.00'
export const PAUSED_OVER = {
  "step": 64,
  "location": {
    "file": "/work/invoices.py",
    "line": 34,
    "col": 0,
    "function": "subtotal",
    "fileId": 1
  },
  "stale": false,
  "stack": [
    {
      "file": "/work/invoices.py",
      "line": 34,
      "function": "subtotal",
      "frameId": 0
    },
    {
      "file": "/work/invoices.py",
      "line": 42,
      "function": "invoice_total",
      "frameId": 1
    },
    {
      "file": "/work/invoices.py",
      "line": 47,
      "function": "main",
      "frameId": 2
    },
    {
      "file": "/work/invoices.py",
      "line": 53,
      "function": "<module>",
      "frameId": 3
    }
  ],
  "block": {
    "file": "/work/invoices.py",
    "function": "subtotal",
    "scopeId": 12,
    "lines": [
      {
        "line": 32,
        "text": "def subtotal(items):"
      },
      {
        "line": 33,
        "text": "    try:"
      },
      {
        "line": 34,
        "text": "        return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)",
        "current": true
      },
      {
        "line": 35,
        "text": "    except (KeyError, TypeError):"
      },
      {
        "line": 36,
        "text": "        # a malformed line should not stop the month's report"
      },
      {
        "line": 37,
        "text": "        return 0.0"
      }
    ]
  },
  "values": [],
  "errors": [],
  "output": {
    "text": "",
    "since": "stop",
    "lines": 0,
    "earlier": 0,
    "truncated": false,
    "seq": 0
  },
  "modified": false,
  "thread": {
    "name": "MainThread",
    "ident": 8362385792
  },
  "recording": false,
  "paused": {
    "step": 64,
    "rid": 19,
    "fileId": 1,
    "line": 34,
    "scopeId": 12,
    "depth": 3,
    "reason": "breakpoint",
    "stack": [
      {
        "frameId": 0,
        "name": "subtotal",
        "fileId": 1,
        "line": 34,
        "rid": 19,
        "scopeId": 12
      },
      {
        "frameId": 1,
        "name": "invoice_total",
        "fileId": 1,
        "line": 42,
        "rid": 24,
        "scopeId": 11
      },
      {
        "frameId": 2,
        "name": "main",
        "fileId": 1,
        "line": 47,
        "rid": 27,
        "scopeId": 1
      },
      {
        "frameId": 3,
        "name": "<module>",
        "fileId": 1,
        "line": 53,
        "rid": 33,
        "scopeId": 0
      }
    ],
    "breakpoint": {
      "path": "/work/invoices.py",
      "line": 34,
      "rid": 19,
      "fileId": 1,
      "resolvedLine": 34,
      "file": "_band_e2e/invoices.py"
    },
    "thread": {
      "name": "MainThread",
      "ident": 8362385792
    },
    "file": "/work/invoices.py"
  },
  "locals": [
    {
      "name": "items",
      "text": "[{'qty': 1, 'sku': 'MON-27', 'unit_price': '1,299.00'}, {'qty': 3, 'sku': 'CBL-02', 'unit_price': 7.5}]",
      "type": "list",
      "length": 2
    }
  ]
}

// `context --live --json` at a plain debug pause on crash.py's uncaught KeyError
export const PAUSED_CRASH = {
  "step": 7,
  "location": {
    "file": "/work/crash.py",
    "line": 2,
    "col": 0,
    "function": "tier_of",
    "fileId": 1
  },
  "stale": false,
  "stack": [
    {
      "file": "/work/crash.py",
      "line": 2,
      "function": "tier_of",
      "frameId": 0
    },
    {
      "file": "/work/crash.py",
      "line": 7,
      "function": "<module>",
      "frameId": 1
    }
  ],
  "block": {
    "file": "/work/crash.py",
    "function": "tier_of",
    "scopeId": 2,
    "lines": [
      {
        "line": 1,
        "text": "def tier_of(customer, tiers):"
      },
      {
        "line": 2,
        "text": "    return tiers[customer]",
        "current": true
      }
    ]
  },
  "values": [],
  "errors": [],
  "output": {
    "text": "gold\n",
    "since": "start",
    "lines": 1,
    "earlier": 0,
    "truncated": false,
    "seq": 5
  },
  "modified": false,
  "thread": {
    "name": "MainThread",
    "ident": 8362385792
  },
  "recording": false,
  "paused": {
    "step": 7,
    "rid": 2,
    "fileId": 1,
    "line": 2,
    "scopeId": 2,
    "depth": 1,
    "reason": "exception",
    "stack": [
      {
        "frameId": 0,
        "name": "tier_of",
        "fileId": 1,
        "line": 2,
        "rid": 2,
        "scopeId": 2
      },
      {
        "frameId": 1,
        "name": "<module>",
        "fileId": 1,
        "line": 7,
        "rid": 5,
        "scopeId": 0
      }
    ],
    "exception": {
      "type": "KeyError",
      "message": "'Ben'",
      "uncaught": true
    },
    "thread": {
      "name": "MainThread",
      "ident": 8362385792
    },
    "file": "/work/crash.py"
  },
  "locals": [
    {
      "name": "customer",
      "text": "'Ben'",
      "type": "str",
      "length": 3
    },
    {
      "name": "tiers",
      "text": "{'Ana': 'gold'}",
      "type": "dict",
      "length": 1
    }
  ]
}

// crash.py as recorded
export const CRASH_SOURCE = "def tier_of(customer, tiers):\n    return tiers[customer]\n\n\ntiers = {\"Ana\": \"gold\"}\nprint(tier_of(\"Ana\", tiers))\nprint(tier_of(\"Ben\", tiers))\n"

// invoices.py as recorded
export const INVOICES_SOURCE = "\"\"\"Monthly revenue from the orders export, with loyalty discounts.\"\"\"\n\nORDERS_CSV = \"\"\"customer,tier,sku,qty,unit_price\nAna,gold,KB-01,2,49.90\nAna,gold,MS-07,1,19.90\nBen,silver,MON-27,1,\"1,299.00\"\nBen,silver,CBL-02,3,7.50\nCaro,,KB-01,1,49.90\nDani,gold,HUB-04,2,34.00\n\"\"\"\n\nDISCOUNTS = {\"gold\": 0.15, \"silver\": 0.10}\n\n\ndef parse_price(raw):\n    text = raw.strip('\"')\n    # numbers only: \"49.90\" -> 49.9; anything else is kept as text for the audit log\n    return float(text) if text.replace(\".\", \"\", 1).isdigit() else text\n\n\ndef parse_orders(csv_text):\n    header, *rows = csv_text.strip().splitlines()\n    orders = {}\n    for row in rows:\n        # the price may be quoted and contain a comma, so split the first four fields only\n        customer, tier, sku, qty, price = row.split(\",\", 4)\n        order = orders.setdefault(customer, {\"tier\": tier or None, \"items\": []})\n        order[\"items\"].append({\"sku\": sku, \"qty\": int(qty), \"unit_price\": parse_price(price)})\n    return orders\n\n\ndef subtotal(items):\n    try:\n        return sum(item[\"qty\"] * item[\"unit_price\"] for item in items)\n    except (KeyError, TypeError):\n        # a malformed line should not stop the month's report\n        return 0.0\n\n\ndef invoice_total(order):\n    rate = DISCOUNTS.get(order[\"tier\"], 0.0)\n    return round(subtotal(order[\"items\"]) * (1 - rate), 2)\n\n\ndef main():\n    orders = parse_orders(ORDERS_CSV)\n    totals = {name: invoice_total(order) for name, order in orders.items()}\n    revenue = round(sum(totals.values()), 2)\n    print(f\"{len(totals)} invoices, revenue {revenue:.2f}\")\n    print(f\"average invoice {revenue / len(totals):.2f}\")\n\n\nmain()\n"
