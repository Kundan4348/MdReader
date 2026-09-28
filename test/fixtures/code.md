# Code fixture

Tagged SQL, long enough for a gutter.

```sql
WITH p AS (
  SELECT date_format(date_add('day', -1, current_date), '%Y') AS y,
         date_format(date_add('day', -1, current_date), '%c') AS m
),
hw AS (
  SELECT h."device.uuid" AS device_uuid, h.realm, -- one per device
         ROW_NUMBER() OVER (PARTITION BY h."device.uuid" ORDER BY h.asset_id DESC NULLS LAST) AS rn
  FROM hardware h, p
  WHERE h.year = p.y AND lower(h.ietf_type) = 'chassis'
)
SELECT d.realm, d.name AS hostname, hw.asset_id
FROM device d
LEFT JOIN hw ON hw.device_uuid = d.uuid AND hw.rn = 1
WHERE d.realm <> 'lab' AND d.count > 1000
ORDER BY d.realm, d.name;
```

Glued fence (first line on the fence, no language):

```WITH q AS (
  SELECT 1 AS one
)
SELECT one FROM q;
```

Untagged JSON:

```
{"name": "x", "count": 3, "ok": true, "tags": ["a", "b"], "nested": {"k": null}}
```

Shell:

```bash
# build and install
cd /Users/kunoku/Documents/MdReader && ./build.sh > "$TMPDIR/mdr.log" 2>&1; echo "rc=$?"
export PAS_ENV=prod
```

Short plain block:

```
just text
```

Python:

```python
def total(rows):
    """Sum the count column."""
    return sum(r["count"] for r in rows if r.get("ok"))  # skip failures
```
