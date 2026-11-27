# Tinycast patch for keepass 0.17.0

Source package: https://crates.io/crates/keepass/0.17.0

The XML reader assigns deterministic replacement IDs to repeated live entry
UUIDs before constructing the database. It keeps the first entry's UUID and
retains the XML traversal order and fields of every entry. Historical versions
remain attached to their owning entries. Opening a vault leaves the source
file intact. A subsequent save writes the distinct IDs.

Cloud merges align both attachment pools by content and protection before
merging entry and historical references. They retain the previous current
entry in history and keep deletion records from both sides.
