# PR #1: spend tiers, the new export format, a report that survives bad rows

- Spend tiers: a customer whose pre-tax subtotal is 500 or more gets 5% off, 1000 or more gets 8%.
  The tier discount stacks with the loyalty discount, capped at 25% in total (settings).
- Platinum tier: invite-only, its rate comes from the settings.
- parse_money accepts the export's quoted prices and keeps non-numeric text for the audit log
  instead of raising, so one odd cell no longer crashes the import.
- subtotal: a malformed line no longer stops the monthly report.
- format_money moved from report.py to money.py; export_csv added to report.py.
