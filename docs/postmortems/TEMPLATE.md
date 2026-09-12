# Postmortem: <incident name>

> Copy this file to `docs/postmortems/YYYY-MM-DD-<slug>.md` and fill it in
> after the incident is fully resolved. Every number below must come from
> Prometheus, Loki, Tempo, or Alertmanager — see
> [docs/incident-response.md](../incident-response.md#mttd-and-mttr-exact-definitions)
> for exactly how MTTD/MTTR are measured. If a number isn't known, write
> "not captured" — never estimate a number to fill the blank. This is
> blameless: name the system and the decision, never a person — see
> [incident-response.md](../incident-response.md#blameless-postmortems).

## Incident Summary

<!-- One or two sentences: what broke, for whom, for how long. -->

## Severity

**SEV-<1-4>** — <!-- one line justifying it against the table in incident-response.md -->

## Impact

<!-- Who/what was affected, in user terms. Pull real numbers from the SLI:
     e.g. "availability SLI dropped to X%, Y failed requests against a
     budget of Z allowed for the period" (see slo:availability:* recording
     rules and the Executive Reliability Overview dashboard). -->

## Timeline

All times from Prometheus/Alertmanager, not memory.

| Time (UTC) | Event |
|---|---|
| | Failure injected / began |
| | Alert reached `firing` (Alertmanager) |
| | Investigation started |
| | Root cause identified |
| | Mitigation applied |
| | Alert reached `resolved` |
| | Incident closed |

## Detection

<!-- Which alert fired (or: no alert fired and a human noticed first --
     that is itself a finding). Link the exact alert name and the
     runbook used. -->

## Root Cause

<!-- The specific technical cause. Link the trace/log evidence, e.g. a
     Tempo trace ID or a Loki query, not just a description. -->

## Contributing Factors

<!-- What made this worse than it had to be, or what let it go undetected
     longer than it should have. Systems and decisions, not people. -->

## Resolution

<!-- What mitigated it, and separately, what (if anything) fixed the
     underlying cause. These are often different actions at different
     times -- say which was which. -->

## MTTD

```text
MTTD = <alert firing time> − <failure injection / start time>
     = <value>
```

## MTTR

```text
MTTR = <alert resolved time> − <alert firing time>
     = <value>
```

## What Went Well

<!-- Be specific -- "the dashboard immediately showed X" is useful,
     "monitoring worked" is not. -->

## What Went Poorly

<!-- Equally specific. This is the section most postmortems soften --
     don't. -->

## Lessons Learned

<!-- What would you tell someone hitting this exact class of problem for
     the first time? -->

## Action Items

| Action | Owner | Priority |
|---|---|---|
| | | |

<!-- If this incident pushed an error budget negative, note that here --
     the error budget policy in docs/slos.md applies until it recovers,
     and these action items are what should be prioritized during that
     freeze. -->
