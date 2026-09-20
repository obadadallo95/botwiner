# Sanitized sample session

This two-record fixture is a tiny pipeline check, not a market sample and not
evidence for a trading claim. It contains one Pump.fun launch and one trade
encoded with synthetic test accounts and the repository's public parser
fixtures.

Run the reproducibility demo from the repository root:

```bash
pnpm research:demo
```

`SHA256SUMS` records the expected bytes for the three committed data files.
The demo parses the raw records, replays them twice, verifies the expected
digest, and runs the paper-trading engine over the resulting events.
