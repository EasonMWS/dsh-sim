# Changelog

## 0.2.1

### The declared host range now includes the prereleases it meant to include

`engines.dsh` was `0.2.1-rc.3 || 0.2.2-rc.5 || >=0.2.1 <0.3.0`, which accepted `0.2.1-rc.3` but
**rejected `0.2.1-rc.5`** — a newer host on the same line. `>=0.2.1 <0.3.0` covers no prerelease at
all, because semver orders `0.2.1-rc.5` below `0.2.1`, and the two exact pins only named two builds.

The range is now `>=0.2.1-rc.3 <0.3.0-0`. The floor is unchanged at rc.3; the `-0` suffixes are what
make prereleases count, and `<0.3.0-0` keeps 0.3.0 out. Verified against the host's own evaluation:

| host | before | after |
| --- | --- | --- |
| 0.2.1-rc.3 | accepted | accepted |
| 0.2.1-rc.5 | **rejected** | accepted |
| 0.2.2-rc.1 | accepted | accepted |
| 0.2.2-rc.5 | accepted | accepted |
| 0.2.0-rc.2 | rejected | rejected |
| 0.3.0 | rejected | rejected |

### Also in this release

- `publishConfig.access` set explicitly, and keywords expanded so the package is findable by what it
  does rather than only by its name.
- No runtime change: the engine, ledger, fingerprint and adapter code is untouched. 26 unit tests and 2
  integration tests still pass.

## 0.2.0

First release. Local failure-to-fix memory: captures a failed tool invocation and the revision that
subsequently worked, then offers the verified fix when the same error recurs in the same repository.

## 0.1.0

Ledger and fingerprint prototype. Ledgers from this version are upgraded in place.
