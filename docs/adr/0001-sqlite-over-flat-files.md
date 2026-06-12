# SQLite over flat JSON files for persistence

Scans accumulate across multiple cities and weeks; a single overwritten findings.json cannot support this. SQLite gives persistent, queryable storage with deduplication by sale_id, a hunts table, and distance/date filtering — all without a separate server process. Flat files were adequate for the single-run POC but cannot support the multi-city, multi-user, multi-week model.
