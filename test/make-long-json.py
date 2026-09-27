#!/usr/bin/env python3
"""Writes test/fixtures/long.json: ~400 pretty-printed lines with nested objects, an array of flat objects (renders
as a table), a deep array and two comments, so the split view has something to scroll and map."""
import json, os

sites = {}
for i in range(12):
    sites[f"site-{i:02d}"] = {
        "region": ["PDX", "IAD", "DUB", "NRT"][i % 4],
        "racks": i * 7 + 3,
        "online": i % 3 != 0,
        "contact": {"name": f"Owner {i}", "email": f"owner{i}@example.com", "shifts": ["day", "night"][: 1 + i % 2]},
    }
rows = [{"partNumber": f"PN-{1000 + i}", "qty": (i * 37) % 90 + 1, "unitCost": round(3.5 + i * 1.25, 2), "vendor": ["Acme", "Globex", "Initech"][i % 3]} for i in range(30)]
doc = {
    "name": "long fixture",
    "version": 3,
    "sites": sites,
    "lineItems": rows,
    "matrix": [[i * j for j in range(4)] for i in range(10)],
    "notes": ["alpha", "beta", "gamma"],
    "closing": {"reviewed": True, "by": "kunoku", "when": "2026-09-27"},
}
text = json.dumps(doc, indent=2)
# a comment above a member and one at the very top, so the tolerant scanner (not JSON.parse) is exercised too
text = text.replace('  "lineItems": [', '  // bill of materials\n  "lineItems": [', 1)
text = "// long fixture for the split view\n" + text + "\n"
out = os.path.join(os.path.dirname(__file__), "fixtures", "long.json")
with open(out, "w") as f:
    f.write(text)
print(out, text.count("\n"), "lines")
