---
"@emdashlms/plugin": patch
---

Repair the Published Lesson Projection through one module operation that scans every page of authoritative published Lessons before reconciling, reports counts, diagnostics, and an explicit complete indicator, and leaves the existing projection untouched when that scan cannot complete. Setup Run now delegates to that operation and only succeeds when the repair reports itself complete.
