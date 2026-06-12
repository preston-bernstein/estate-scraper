# Hunts carry an owner name field without authentication

The app starts as a household tool with no login, but is designed to eventually support a broader user base. Hunts store a plain-text owner name from day one so the schema does not require a breaking migration when auth is introduced. No passwords, sessions, or access control exist yet — the owner field is informational only.
