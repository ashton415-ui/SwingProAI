# Private Worker Preflight — Offline Runtime Verification

This document describes `privateWorkerPreflight.runtime.test.ps1`, an offline,
black-box **runtime** test harness for `scripts/private-worker-preflight.ps1`.
It complements — and does not duplicate — `privateWorkerPreflight.test.js`
(the static Node.js suite, which reads the `.ps1`/`.md` files as plain text
and never executes PowerShell) and `PRIVATE_WORKER_PREFLIGHT.md` (the
human-facing operational contract for the tool itself).

## What this harness proves that static analysis cannot

The static suite proves the production script's *source text* has the right
shape: the right command schemas are declared, the right blocker/warning
strings appear in the right functions, the right `@(...)` array-safety
wrapping is present at the right call sites, and so on. It cannot prove any
of that code actually *behaves* correctly when PowerShell parses, binds, and
executes it — parameter binding quirks, pipeline scalar/array coercion,
external-process argument marshalling, and environment inheritance are all
runtime concerns that only manifest when the script actually runs.

This harness closes that gap by:

1. Building a temporary, synthetic `gcloud` executable (a `.cmd` launcher
   plus a PowerShell fixture dispatcher) entirely inside the OS temp
   directory, never inside this repository.
2. Prepending only that temporary directory to `PATH` for the duration of
   each scenario.
3. Positively verifying — from a **child process**, using exactly the
   environment the real preflight child will receive — that `gcloud`
   resolves only to the synthetic executable, before ever invoking the real
   script. If that verification ever fails, the harness aborts (exit 2)
   rather than risk invoking a real `gcloud` on the developer's machine.
4. Actually executing the real `scripts/private-worker-preflight.ps1` as a
   child process (via `powershell.exe -File`), against synthetic JSON
   fixtures served by the dispatcher — never against Google Cloud, Supabase,
   Gemini, Vercel, or any other network service.
5. Inspecting the resulting exit code, JSON report, stdout, stderr, and a
   structured invocation log of every command the synthetic `gcloud`
   received, using a small native PASS/FAIL assertion framework.

## Absolute safety guarantees

- **No network access, ever.** The synthetic `gcloud` dispatcher only reads
  local JSON fixture files written by this harness; it never makes an HTTP
  request.
- **No real `gcloud`.** `Resolve-GcloudCommand` in the production script only
  accepts `Application`/`ExternalScript` command types resolved via
  `Get-Command`; the harness positively verifies (from a child process) that
  this resolves solely to the synthetic sandbox executable before every
  scenario, and aborts if it does not.
- **No Docker, no deployment, no migration, no credential access.** Nothing
  in this harness invokes Docker, `gcloud` mutating verbs, database
  migrations, or reads real credential files.
- **Nothing created outside the OS temp directory.** The sandbox root is
  computed with `[System.IO.Path]::GetFullPath()` and explicitly checked
  against the canonicalized repository root before creation; the harness
  refuses to proceed if the sandbox would land inside the repository.
- **Full cleanup.** The sandbox directory (synthetic `gcloud.cmd`,
  dispatcher, all scenario fixtures, invocation logs, and generated reports)
  is removed in a `finally` block, and the original `PATH` is restored,
  regardless of pass/fail outcome.
- **Never commits or pushes.** This harness only reads/writes files under the
  OS temp directory and reads the two files it is permitted to reference; it
  performs no `git` operations.

## Architecture

### Synthetic `gcloud`

- `gcloud.cmd` — a thin batch launcher (`%~dp0`-relative) that forwards all
  arguments to `gcloud-dispatcher.ps1` and propagates its exit code exactly.
- `gcloud-dispatcher.ps1` — a PowerShell script that:
  1. Appends a JSON line (`{timestampUtc, arguments}`) to
     `invocation-log.jsonl` in the current scenario's directory (read from
     the `RUNTIME_HARNESS_FIXTURE_DIR` environment variable) for every
     invocation, before doing anything else.
  2. Rejects, as defense-in-depth, any argument list containing a mutating
     verb (`create`, `update`, `delete`, `deploy`, `submit`,
     `add-iam-policy-binding`, `remove-iam-policy-binding`,
     `set-iam-policy`, `resume`, `pause`, `access`) or an
     authentication-override flag (`--impersonate-service-account`,
     `--access-token-file`, `--credential-file-override`, `--account`,
     `--configuration`, `--billing-project`, `--flags-file`,
     `--trace-token`, `--log-http`).
  3. Matches the argument list against the exact 22 read-only command
     families the production script's own `$script:CommandSchemas`
     allowlist defines (`version`; `auth list`; `config list`;
     `projects describe`/`get-iam-policy`; `services list`;
     `artifacts repositories list`/`describe`/`get-iam-policy`;
     `run services list`/`describe`/`get-iam-policy`;
     `iam service-accounts list`/`describe`/`get-iam-policy`;
     `secrets list`/`describe`/`versions list`/`get-iam-policy`;
     `tasks queues list`/`describe`/`get-iam-policy`).
  4. For a positional-resource family (describe/get-iam-policy/versions
     list), disambiguates the fixture by the sanitized positional resource
     name, so a scenario invoking the same family against multiple distinct
     resources (three service accounts, two secrets) gets the right
     synthetic payload for each.
  5. Reads the matching fixture envelope (`{ExitCode, Stdout, Stderr}`) and
     emits it verbatim, exiting with the fixture's exit code. An
     unrecognized command, missing fixture, forbidden token, or forbidden
     flag causes the dispatcher to reject the call with a distinct non-zero
     exit code and a diagnostic to stderr — it never falls through to any
     kind of real execution.

### Scenario execution

Each scenario:

1. Writes its fixture envelopes into a per-scenario `fixtures/` directory.
2. Snapshots and clears any pre-existing `CLOUDSDK_AUTH_*` environment
   variables (so a clean scenario cannot inherit a stray override from the
   developer's own shell), restoring them afterward.
3. Sets `PATH` to `<sandbox>\bin;<original PATH>` and
   `RUNTIME_HARNESS_FIXTURE_DIR` to the scenario directory.
4. Re-verifies gcloud resolution from a child process before invoking the
   real preflight script.
5. Invokes `scripts/private-worker-preflight.ps1` as a child
   `powershell.exe -File` process with the scenario's CLI parameters,
   capturing stdout, stderr, and exit code to files.
6. Parses the JSON report (if written) and the invocation log, and runs the
   scenario's assertions.
7. Restores environment variables scoped to the scenario.

All native-command invocations that redirect stderr are wrapped with
`$ErrorActionPreference = 'Continue'` for the duration of the call: Windows
PowerShell raises a terminating `NativeCommandError` for *any* stderr output
from a redirected native command while `$ErrorActionPreference = 'Stop'` is
active, even when the output is entirely benign — the same hazard the
production script's own `Invoke-ReadOnlyGcloudCommand` guards against with
its own `try`/`catch` around an identical call shape.

## Scenarios

| Scenario | Purpose |
|---|---|
| **A** | Clean run, required discovery only (no optional target parameters supplied). Expects exit 0, zero blockers, exactly the 11 generic discovery commands invoked. |
| **B** | Clean run, all 8 optional target parameters supplied. Expects exit 0, zero blockers, all 22 read-only command families invoked (29 total calls, since 3 service accounts and 2 secrets share families). |
| **C** | Project lifecycle state is not `ACTIVE`. Expects exit 2 and the exact `project lifecycle state not ACTIVE: <value>` blocker text. |
| **D** | An invalid `-ProjectId` fails local validation before any cloud discovery. Expects exit 3 and zero gcloud invocations. |
| **E** | A `CLOUDSDK_AUTH_*` environment variable is set to a unique sentinel value. Expects exit 2, the exact CLOUDSDK_AUTH_* override blocker text, and the sentinel value absent from the report, stdout, and stderr. |
| **F** | `projects get-iam-policy` returns structurally malformed JSON (a binding with a non-string `role`, tagged with a sentinel). Expects a non-zero exit code, the exact `generic discovery incomplete: projectIamPolicy (status: failed)` blocker text, and the sentinel absent from all captured output. |
| **G-zero / G-one / G-multiple** | The task-caller Cloud Run invocation binding is absent / present-but-conditional (a scalar `Where-Object` result) / present as multiple conditional bindings across two scopes (an array `Where-Object` result) — the exact scalar-vs-array pipeline-concatenation site fixed in the prior static-hardening phase. Each expects no unhandled-exception exit code (4), and (for one/multiple) the exact conditional-IAM-binding human-review warning text with sentinel-tagged condition fields absent from all captured output. |
| **Q-multiple-queues-warning** | Reuses scenario A's required-discovery-only fixture set with `tasks-queues-list` overridden to two queue objects — proves the defect-4 correction through the real, full, end-to-end preflight run: exit 0, zero blockers, exactly one `"multiple candidate queues"` warning. |
| **Empty-collection-regression** | A standalone, gcloud-independent probe proving the `AllowEmptyCollection` correction (defect 1, see below): both helpers accept a genuinely empty `List[string]`, a success result leaves the list empty, and a failure/`not_found` result still adds the correct, unchanged blocker text. |
| **GetSafeProperty-regression** | A standalone, gcloud-independent probe proving the `.PSObject.Properties` correction (defect 2, see below): normal reads, nested paths, absent/explicit-null properties, and a scalar-then-nonexistent-nested path all behave correctly; a deliberately throwing property getter is also exercised and its actual (documented) behavior verified. |
| **GetPropertyReadOutcome-NotePropertyOnly-regression** | A standalone, gcloud-independent probe proving the NoteProperty-only fail-closed correction (defect 3, see below): ordinary present/missing/explicit-null NoteProperty reads, a throwing ScriptProperty getter and a throwing compiled CLR property getter (both rejected by MemberType with a proven-zero invocation count), `ConvertTo-SafeGcloudConfigListResult` accepting pristine config data, and `Test-IsUnconditionalBinding`'s full absent/null/present/throwing-getter matrix. |
| **CloudTasksQueues-EmptyArrayPipelineUnrolling-regression** | A standalone, gcloud-independent probe proving the `@(...)`-wrapped correction (defect 4, see below): null input, an empty-JSON-array-after-`ConvertFrom-Json`, one queue object, and two queue objects all produce the correct `Count`, plus a direct side-by-side proof that the old bare assignment still collapses to `$null` while the new wrapped one never does. |
| **GetSafeProperty-ArrayIdentity-regression** | A standalone, gcloud-independent probe proving the `Write-Output -NoEnumerate` correction (defect 5, see below): scalar, null, empty-array, one-element, two-element, and one-object-array properties all preserve their correct type/Count/contents; a nested path ending in a one-element array is preserved; a missing property still returns `$null`; and `ConvertTo-SafeIamPolicyResult` correctly accepts one-member and multi-member bindings while still failing closed on a genuinely malformed scalar `members` value. |

Every scenario asserts report-safety (no sentinel value ever appears in the
report JSON, stdout, or stderr) where a sentinel is used, and
command-containment (every invocation matched a known read-only family, no
forbidden token or auth-override flag was ever sent, and every
`--project`/`--region`/`--location` value exactly matched the scenario's
configured value).

## Defect 1 (found, corrected, and regression-covered): empty-collection parameter binding

Running these scenarios originally surfaced a genuine, deterministic runtime
defect in `scripts/private-worker-preflight.ps1` that static text/AST
analysis cannot detect, because the source was syntactically valid — it only
manifested when PowerShell actually bound parameters at runtime.

**Root cause:** `Add-GenericDiscoveryBlocker` (and `Add-TargetVerificationBlockers`,
which shares the same parameter shape) declared its blocker-accumulator
parameter as:

```powershell
[Parameter(Mandatory)] [System.Collections.Generic.List[string]] $Blockers
```

Windows PowerShell's mandatory-parameter binding rejects an **empty** (but
non-null) collection passed to a `Mandatory` collection-typed parameter
without `AllowEmptyCollection`, raising:

```
Cannot bind argument to parameter 'Blockers' because it is an empty collection.
```

`$blockers` is created as a freshly-empty
`System.Collections.Generic.List[string]` in
`Invoke-PrivateWorkerPreflightMain`, and `Add-GenericDiscoveryBlocker` was
called with it for the very first time (the `gcloudVersion` check)
immediately — before any blocker could possibly have been added yet, in
**every invocation of the script, regardless of environment state**. That
first call always threw. The exception was caught by the outer evaluation
`try`/`catch`, which appended a generic
`"unexpected evaluation error: Cannot bind argument to parameter 'Blockers' because it is an empty collection."`
blocker and proceeded to write the report — but every blocker/warning check
after that point in the same `try` block never ran, because the exception
unwound past all of it.

**Correction applied:** both parameters now declare `[AllowEmptyCollection()]`
alongside `[Parameter(Mandatory)]`, with the exact same `List[string]` type
and no `[AllowNull()]`:

```powershell
[Parameter(Mandatory)]
[AllowEmptyCollection()]
[System.Collections.Generic.List[string]] $Blockers
```

This is the narrowest possible fix: the parameter remains mandatory (a caller
still cannot omit it or pass `$null`), remains exactly `List[string]`-typed,
and neither function's blocker logic, blocker/warning text, or callers
changed at all — only the empty-collection rejection at the parameter-binding
boundary was lifted.

**Regression coverage:** the harness's `Empty-collection-regression` scenario
dot-sources the real production script in an isolated child process
(independent of the gcloud sandbox) and proves, against the real functions:

1. `Add-GenericDiscoveryBlocker` accepts a genuinely empty `List[string]`
   without a parameter-binding exception.
2. A `success` result leaves that list empty.
3. A `failed` result still adds the exact, unchanged
   `"generic discovery incomplete: gcloudVersion (status: failed)"` blocker.
4. `Add-TargetVerificationBlockers` accepts a genuinely empty `List[string]`
   without a parameter-binding exception.
5. A `success` target result leaves the list empty.
6. A `not_found` target result still adds the exact, unchanged
   `"missing supplied target resource: WorkerServiceName"` blocker.

`privateWorkerPreflight.test.js` additionally proves statically that both
`$Blockers` parameters carry `AllowEmptyCollection`, remain `Mandatory` and
`List[string]`-typed, never gained `AllowNull`, that the blocker text in both
helper bodies is byte-for-byte unchanged, and that no other production
function signature was touched (the one pre-existing `AllowEmptyCollection`
on `$Arguments` in `Invoke-ReadOnlyGcloudCommand` is untouched and accounted
for explicitly).

## Defect 2 (found, corrected, and regression-covered): Get-SafeProperty / AsPSObject on Windows PowerShell 5.1

Re-running the full scenario suite after applying the defect-1 correction
surfaced a **second, distinct** runtime defect — again invisible to static
analysis, and again specific to the exact required execution platform
(Windows PowerShell 5.1.26100.x, Desktop edition).

**Root cause:** `Get-SafeProperty`, the central safe-accessor used throughout
the script to read any parsed `ConvertFrom-Json` value, did:

```powershell
$wrapped = [System.Management.Automation.PSObject]::AsPSObject($current)
$member = $wrapped.Properties[$propertyName]
```

On Windows PowerShell 5.1 Desktop, `[PSObject]::AsPSObject($psCustomObject)`
returns the **same object reference**, unchanged — not a distinct `PSObject`
wrapper — for `PSCustomObject` *and* for ordinary compiled CLR object types
alike, and a raw object of either kind has no real `.Properties` member of
its own (only `.PSObject.Properties`). Under `Set-StrictMode -Version Latest`
(active throughout this script), that bare `.Properties` access threw:

```
The property 'Properties' cannot be found on this object. Verify that the property exists.
```

This was not specific to any unusual JSON shape: **any** object
`ConvertFrom-Json` produces from ordinary object-shaped JSON is a
`PSCustomObject`, so this fired for virtually every real (or realistic
synthetic) piece of gcloud JSON output `Get-SafeProperty` was ever asked to
read.

**Correction applied:** the property collection is now read through the
object's intrinsic `.PSObject.Properties` view, which is always safe to
read regardless of the underlying type:

```powershell
$member = $current.PSObject.Properties[$propertyName]
```

This preserves every existing traversal behavior: a null current object
returns null before any lookup; an absent property returns null; an
explicit-null property returns null; a present property advances traversal
via `$current = $member.Value`; nested property paths continue to work; and
no dynamic (`$current.$propertyName`) access, `Invoke-Expression`, JSON
re-conversion, or property enumeration was introduced.

**One documented, verified nuance:** on Windows PowerShell 5.1, reading
`.PSObject.Properties[name].Value` for a property whose getter *itself*
throws (a `ScriptProperty` or a computed CLR property, constructed
deliberately) does not propagate that exception — it silently returns
`$null`, with nothing recorded in `$Error` either. This was verified
independently for both a `ScriptProperty` and a compiled CLR property; the
only accessor that reliably surfaces such an exception is direct reflection
(`GetType().GetProperty(...).GetValue(...)`), which is a fundamentally
heavier mechanism than "the smallest platform-compatible correction" this
round scoped, and was not adopted. This has no practical safety impact:
every real object `Get-SafeProperty` is ever asked to read is
`ConvertFrom-Json` output, whose members are always plain `NoteProperty`
values that store a fixed value and cannot throw on read — the deliberately
throwing case only exists as a synthetic construction in the regression
probe itself.

**Regression coverage:** the harness's `GetSafeProperty-regression` scenario
dot-sources the real production script in an isolated child process
(independent of the gcloud sandbox) and proves, against the real function:

1. A normal `ConvertFrom-Json` property reads correctly
   (`{"a":"b"}` path `a` → `"b"`).
2. A nested property path reads correctly
   (`{"outer":{"inner":"value"}}` path `outer,inner` → `"value"`).
3. An absent property returns `null` without throwing.
4. An explicitly `null` property returns `null` without throwing.
5. A scalar intermediate value followed by a nonexistent nested property
   returns `null` without an unhandled exception.
6. A deliberately throwing property getter (constructed via
   `Add-Member -MemberType ScriptProperty`) does **not** propagate — it
   returns `$null`, matching the documented, verified PowerShell 5.1 engine
   behavior above, not the originally-hoped-for propagation.

`privateWorkerPreflight.test.js` additionally proves statically that
`Get-SafeProperty` reads through `.PSObject.Properties`, that the direct
`$wrapped.Properties[...]`/`AsPSObject(` pattern is absent from its body,
that dynamic `$current.$propertyName` access was never introduced, that the
null-current guard and missing-member null return remain, that the function
still assigns `$current = $member.Value`, and that the sibling function
`Get-PropertyReadOutcome` — the only other user of the old `AsPSObject(...)`
/ `.Properties[...]` pattern in the script — was independently corrected in
a later round with its own, differently-shaped fix (see defect 3 below).

## Defect 3 (found while verifying defect 2's correction; corrected and regression-covered)

Re-running the full scenario suite after applying the defect-2 correction
still left scenarios A, B, G-zero, G-one, and G-multiple failing. Isolating
why surfaced a **third, distinct** runtime defect, in the same family as
defect 2 but in a different function.

**Root cause:** `Get-PropertyReadOutcome` — a sibling of `Get-SafeProperty`
built for a different purpose (distinguishing "absent" from "explicitly
null" from "the read itself failed") — used the identical, still-uncorrected
pattern:

```powershell
$wrapped = [System.Management.Automation.PSObject]::AsPSObject($Object)
$member = $wrapped.Properties[$PropertyName]
```

wrapped in its own local `try`/`catch`. Because this bare `.Properties`
access throws for virtually any object on Windows PowerShell 5.1 Desktop
(the same underlying engine behavior as defect 2), that `catch` fired on
**every call, regardless of whether the requested property was actually
present** — so `Get-PropertyReadOutcome` reported `AccessFailed = $true` for
an entirely ordinary, present property read.

**First correction attempt, rejected before being applied:** replacing the
`AsPSObject`/`.Properties` pair with the intrinsic-collection lookup used by
`Get-SafeProperty` (`$member = $Object.PSObject.Properties[$PropertyName]`),
followed by an ordinary property read (`$value = $Object.$PropertyName`)
inside the existing `try`/`catch`, was proposed and verified in an isolated
Windows PowerShell 5.1 child process *before* being written. That
verification failed: neither `$Object.$PropertyName` (dotted access) nor
`.PSObject.Properties[name].Value` surfaces a throwing `ScriptProperty` or
compiled CLR property getter's exception as a catchable, terminating error —
even with `$ErrorActionPreference = 'Stop'` set at both script and function
scope, matching the production script exactly. The getter's exception is
demoted to a non-terminating error and swallowed; the read silently returns
`$null`. Had this been implemented as first proposed, a hostile or
misbehaving getter would have produced `Found=$true, Value=$null,
AccessFailed=$false` — indistinguishable from a legitimate explicit-null —
instead of `AccessFailed=$true`, which is a fail-*open* regression in
exactly the code path (`Test-IsUnconditionalBinding`) whose contract depends
on failing closed for an unreadable IAM binding condition. This was caught
and rejected before any production edit was made.

**Correction actually applied — NoteProperty-only fail-closed design:**
`Get-PropertyReadOutcome`'s real production inputs are reviewed plain data
only: parsed JSON (`ConvertFrom-Json` `PSCustomObject`) and internally-built
`[pscustomobject]` literals. Both forms expose their fields exclusively as
`NoteProperty` members — plain stored values with no getter code to run.
Rather than depending on whether a given getter's exception happens to be
catchable (which the verification above proved it usually is not), the
helper now classifies the member **before** ever reading it, and only reads
a member it has classified as safe:

```powershell
$member = $Object.PSObject.Properties[$PropertyName]
if ($null -eq $member) {
    return [pscustomobject]@{ Found = $false; Value = $null; AccessFailed = $false }
}
if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) {
    return [pscustomobject]@{ Found = $false; Value = $null; AccessFailed = $true }
}
$value = $member.Value
return [pscustomobject]@{ Found = $true; Value = $value; AccessFailed = $false }
```

Member existence is checked via `.PSObject.Properties[$PropertyName]` — a
lookup that never invokes a getter, regardless of member type — the same
intrinsic collection `Get-SafeProperty` uses. The actual value is read via
`$member.Value` only once `.MemberType` has confirmed the member is a
`NoteProperty`; any other member type (`ScriptProperty`, `CodeProperty`,
`AliasProperty`, an adapted CLR `Property`, a `ParameterizedProperty`, or any
dynamic member) is rejected as `AccessFailed = $true` **before** it is ever
invoked — so a hostile or misbehaving getter is never executed at all, and
the fail-closed guarantee no longer depends on PowerShell's engine-specific,
unreliable exception-propagation behavior for member access. No dynamic
`$Object.$PropertyName` access, `Invoke-Expression`, reflection
(`InvokeMember`, `GetType().GetProperty(...)`), or JSON re-conversion was
introduced.

This preserves every existing outcome: a `$null` object is absent, not
failed; a missing member is absent, not failed; an explicitly-null
`NoteProperty` is `Found=$true, Value=$null, AccessFailed=$false`; a present
non-null `NoteProperty` is `Found=$true` with its value; and any rejected
member type is `Found=$false, Value=$null, AccessFailed=$true`. Both
concrete consequences described in earlier drafts of this document are now
fixed: `ConvertTo-SafeGcloudConfigListResult` correctly classifies pristine
`gcloud config list` output as `status: success` (its `auth`/`core` fields
are always `ConvertFrom-Json` `NoteProperty` members), and
`Test-IsUnconditionalBinding` correctly reports a binding with no
`condition` field at all as unconditional.

**Regression coverage:** the harness's
`GetPropertyReadOutcome-NotePropertyOnly-regression` scenario dot-sources the
real production script in an isolated child process (independent of the
gcloud sandbox) and proves, against the real functions:

- **A/B.** An ordinary present `NoteProperty` — on a plain `[pscustomobject]`
  and on real `ConvertFrom-Json` output — returns `Found=$true` with the
  expected value and `AccessFailed=$false`.
- **C.** A missing property returns `Found=$false, Value=$null,
  AccessFailed=$false`.
- **D.** An explicitly-null `NoteProperty` returns `Found=$true,
  Value=$null, AccessFailed=$false`.
- **E.** A deliberately throwing `ScriptProperty` getter returns
  `Found=$false, Value=$null, AccessFailed=$true` — and a dedicated
  invocation counter, incremented only if the getter itself ever ran, stays
  at `0`, proving the getter was never invoked.
- **F.** A deliberately throwing compiled CLR property getter (via
  `Add-Type`) returns the same `AccessFailed=$true` outcome, and a static
  counter on the compiled type proves its getter was likewise never invoked.
- **G.** `ConvertTo-SafeGcloudConfigListResult` accepts pristine,
  structurally valid config data: `status` stays `success`, and the
  normalized `coreAccount` / four auth-override booleans are exactly as
  expected.
- **H.** `Test-IsUnconditionalBinding` returns `$true` for an absent
  condition, `$true` for an explicitly-null condition, `$false` for a
  present non-null condition, and `$false` for a `ScriptProperty`-typed
  `condition` member — with its invocation counter proving that getter was
  never invoked either.

`privateWorkerPreflight.test.js` additionally proves statically that
`Get-PropertyReadOutcome` looks up members via
`$Object.PSObject.Properties[$PropertyName]`, that `AsPSObject`/
`$wrapped.Properties` are absent from its body, that the `MemberType`
rejection happens strictly before `$member.Value` is ever read, that a
non-`NoteProperty` member returns the exact `AccessFailed=$true` shape, that
dynamic `$Object.$PropertyName` access / `Invoke-Expression` / `InvokeMember`
/ `GetType().GetProperty` are all absent, that the helper's own doc comment
documents the NoteProperty-only contract (not a claim that arbitrary getter
exceptions must propagate), and that `Test-IsUnconditionalBinding`'s body is
byte-for-byte (whitespace-normalized) unchanged by this correction.

## Defect 4 (found while verifying defect 3's correction; corrected and regression-covered)

Re-running the full scenario suite after applying the defect-3 correction
still left scenarios A, B, G-zero, G-one, and G-multiple failing — but with
a **new** error, `"unexpected evaluation error: The property 'Count' cannot
be found on this object."`, replacing the old `configList`/missing-binding
blockers. This is a **fourth, distinct** runtime defect that defect 3 was
masking, not causing: with `Get-PropertyReadOutcome` now correct,
`configList` succeeds and evaluation proceeds much further into the script
than it ever had before in a full end-to-end run — far enough to reach a
latent bug that had simply never been exercised until now.

**Root cause:** the Cloud Tasks queues check —

```powershell
if ($taskQueuesResult.status -eq 'success') {
    $queues = ConvertTo-DataArray $taskQueuesResult.data
    if ($queues.Count -gt 1) {
        $warnings.Add('multiple candidate queues') | Out-Null
    }
}
```

— assigned the result of `ConvertTo-DataArray` directly to `$queues` with no
`@(...)` wrapping at the assignment, then read `.Count` on it directly.
`ConvertTo-DataArray $null` executes `return @()`, but this is a classic
PowerShell pipeline-unrolling pitfall: when a function writes an **empty**
array to the output pipeline, zero objects actually flow through the
pipeline, and a caller capturing that into a plain scalar variable
(`$queues = ConvertTo-DataArray ...`, not `$queues = @(ConvertTo-DataArray
...)`) receives `$null`, not an empty array. Under `Set-StrictMode -Version
Latest`, `$null.Count` then throws
`PropertyNotFoundException: The property 'Count' cannot be found on this
object.` This is unrelated to JSON parsing, `Get-PropertyReadOutcome`, or
either prior correction — every other call site of `ConvertTo-DataArray` in
the script either iterates the result with `foreach` (safe on `$null`) or
immediately re-wraps it with `@(...)` before any `.Count` use; this was the
sole unwrapped, directly-`.Count`-accessed call site.

**Correction applied:** the assignment is wrapped with an outer `@(...)`,
forcing a real (possibly empty) array regardless of how many elements
`ConvertTo-DataArray` produced:

```powershell
$queues = @(ConvertTo-DataArray $taskQueuesResult.data)
if ($queues.Count -gt 1) {
    $warnings.Add('multiple candidate queues') | Out-Null
}
```

`ConvertTo-DataArray` itself is unchanged — the fix is purely at the call
site, the narrowest possible correction. `@(...)` around a function call
forces PowerShell to always capture the full output as an array, regardless
of whether the underlying pipeline delivered zero, one, or many objects; it
is the same pattern already used at every other `ConvertTo-DataArray` call
site in the script that needs an array-typed result rather than an
iterable. The existing `$taskQueuesResult.status -eq 'success'` guard, the
`$queues.Count -gt 1` condition, and the exact `'multiple candidate queues'`
warning text are all byte-for-byte unchanged; zero queues still produces no
warning and no blocker, and no new blocker path was introduced for the
zero-queues case.

**Smallest reproduction** (isolated, no dependency on any other part of the
script):

```powershell
function ConvertTo-DataArray {
    param($Data)
    if ($null -eq $Data) { return @() }
    return @($Data)
}
$queues = ConvertTo-DataArray $null
# $queues is $null here, not an empty array.
$queues.Count
# throws: The property 'Count' cannot be found on this object.

$queuesFixed = @(ConvertTo-DataArray $null)
# $queuesFixed is a real, empty array here.
$queuesFixed.Count
# 0 — no exception.
```

It reproduced identically inside the full script whenever `tasks queues
list` succeeded with zero queues (an empty JSON array `[]`, which
`ConvertFrom-Json` on Windows PowerShell 5.1 itself already normalizes to
`$null` before `ConvertTo-DataArray` is even called — a second, compounding
quirk, though the pipeline-unrolling behavior alone was sufficient to
reproduce this on its own, as shown above).

**Regression coverage:** the harness's
`CloudTasksQueues-EmptyArrayPipelineUnrolling-regression` scenario
dot-sources the real production script in an isolated child process
(independent of the gcloud sandbox) and proves, against the real
`ConvertTo-DataArray` with the exact normalized expression now used at the
call site:

- **A.** `@(ConvertTo-DataArray $null)` is a real array with `Count = 0`.
- **B.** An empty JSON array, after Windows PowerShell 5.1's own
  `ConvertFrom-Json` normalization (which itself collapses `"[]"` to
  `$null`), still produces `Count = 0` through the normalized expression.
- **C.** One queue object produces `Count = 1`.
- **D.** Two queue objects produce `Count = 2`.
- A direct side-by-side proof that the OLD bare assignment pattern still
  collapses to `$null` for empty input, while the NEW `@(...)`-wrapped
  pattern never does.

This is deliberately **in addition to**, not instead of, exercising the
corrected line through the real, full, end-to-end preflight run:

- **Scenario A** (zero queues, an empty `tasks-queues-list` fixture) now
  passes in full — exit 0, zero blockers — proving the queues check no
  longer throws, plus a dedicated assertion that no spurious `"multiple
  candidate queues"` warning appears for zero queues.
- **Scenario B** (one queue) carries a dedicated assertion that no
  `"multiple candidate queues"` warning appears for exactly one queue.
- **Scenario Q** (new: two queues, reusing scenario A's required-discovery-
  only fixture set with only `tasks-queues-list` overridden) proves exit 0,
  zero blockers, and exactly one `"multiple candidate queues"` warning for
  two queue objects, through the real end-to-end preflight run.

`privateWorkerPreflight.test.js` additionally proves statically that the
queues assignment is exactly `$queues = @(ConvertTo-DataArray
$taskQueuesResult.data)`, that the old bare assignment is absent, that the
status guard and `Count -gt 1` condition are unchanged, that the warning
text is byte-for-byte unchanged, that zero queues can never be converted
into a blocker, that `ConvertTo-DataArray` itself is untouched, and that no
other production helper or evaluation block changed during this correction.

## Defect 5 (found while verifying defect 4's correction; corrected and regression-covered)

Re-running the full scenario suite after applying the defect-4 correction
resolved scenario A completely and confirmed the new `Q` (two-queues)
scenario passes in full — but scenario B, and consequently G-zero, G-one,
and G-multiple (all of which reuse B's full-target fixture shape), still
failed. Critically, **this was not caused by the defect-4 correction**:
scenario B's `tasks-queues-list` fixture has exactly one queue, which never
exercises the empty-array collapse defect-4 fixed, either before or after
that correction — this failure was present in every harness run throughout
this entire multi-round effort, masked at various points by defects 1–4,
and was simply the next thing blocking full harness success once those were
all resolved.

**Root cause:** `Get-SafeProperty` — the central safe-accessor used
throughout the script, corrected once already for defect 2 — ended with:

```powershell
function Get-SafeProperty {
    param($Object, [Parameter(Mandatory)] [string[]] $PropertyPath)
    $current = $Object
    foreach ($propertyName in $PropertyPath) {
        if ($null -eq $current) { return $null }
        $member = $current.PSObject.Properties[$propertyName]
        if ($null -eq $member) { return $null }
        $current = $member.Value
    }
    return $current
}
```

`return $current` writes `$current` to the success output stream, and
PowerShell enumerates array values placed on the pipeline by default. When
`$current` is an array with **exactly one element**, and the caller captures
the function's return value into a plain scalar variable (`$membersRaw =
Get-SafeProperty ...`, not `$membersRaw = @(Get-SafeProperty ...)`), the
caller receives that single element itself — not a one-element array. The
array wrapper is silently lost. This is the same underlying PowerShell
pipeline-enumeration behavior as defect 4 (`ConvertTo-DataArray`'s `return
@()` collapsing to `$null` for zero elements), but manifesting for the
one-element case instead of the zero-element case, and in a completely
different function.

**Observed consequence:** `ConvertTo-SafeIamPolicyResult` reads each
binding's `members` field via `Get-SafeProperty -Object $binding
-PropertyPath @('members')`. A binding granted to exactly one member —
an extremely common, entirely realistic real-world IAM policy shape, not a
synthetic edge case — had its one-element `members` array collapsed to a
bare string by this defect. `Test-IsScalarValue` then correctly identified
that bare string as a scalar (strings are scalars), and the policy was
rejected as `"IAM policy contained a binding entry with no usable
members."`, failing the *whole* IAM policy result closed. In scenario B,
every single-member binding across `projectIamPolicy`,
`workerServiceIamPolicy`, `queueIamPolicy`, `taskCallerServiceAccountIamPolicy`,
`supabaseSecretIamPolicy`, and `geminiSecretIamPolicy` was affected — every
one of those results failed, which is why B never reached a clean report,
and why G-zero/G-one/G-multiple (which depend on `workerServiceIamPolicy`
and `projectIamPolicy` succeeding to evaluate the task-caller invocation
binding at all) still showed the missing-invocation-binding blocker
regardless of what the fixture's actual binding condition looked like.

Because this collapse happens inside `Get-SafeProperty` itself, it was not
specific to `members` or to IAM policies — **any** call site anywhere in the
script that reads an array-valued property through `Get-SafeProperty` and
expects an array back was silently vulnerable whenever that array happened
to have exactly one element, including against real, well-formed `gcloud`
output — a single-member binding is not a malformed or unusual shape.

**Correction applied:** the function's terminal statement now writes
`$current` to the pipeline with `-NoEnumerate` before returning:

```powershell
    # ... traversal loop unchanged ...
    Write-Output -NoEnumerate $current
    return
}
```

`Write-Output -NoEnumerate` places its argument onto the success output
stream as a single, unenumerated object, regardless of whether that object
is `$null`, a scalar, or an array of any length — it suppresses exactly the
per-element pipeline enumeration that `return $current` (equivalent to a
bare `Write-Output $current`) triggers by default. This is a strictly
narrower fix than reshaping `$current` itself (e.g. wrapping it in a
one-element outer array, which would also change what a *scalar* result
looks like to the caller): scalar values still arrive at the caller as bare
scalars, `$null` still arrives as `$null`, and arrays of every length —
zero, one, or many — arrive as the exact same array object that was stored
in `$current`, with their original element count and contents intact. No
other part of the function changed: the `PropertyPath` traversal loop, the
null-current guard, the absent-member null return, and the `$current =
$member.Value` assignment are all byte-for-byte unchanged. Neither
`Get-PropertyReadOutcome` nor `ConvertTo-DataArray` were touched — this
defect is unrelated to either of them, and both remain exactly as defects 3
and 4 left them.

Before making this change, the exact terminal form (`Write-Output
-NoEnumerate $current` followed by a bare `return`) was verified in an
isolated Windows PowerShell 5.1 child process against every required
outcome: a scalar string and a scalar boolean both remained scalars; `$null`
remained `$null`; an empty array remained an array with `Count 0`; one- and
two-element string arrays remained arrays with their exact `Count` and
element order; a one-element array of `PSCustomObject` remained an array
with its object's fields intact; a nested property path ending in a
one-element array still returned an array; and exactly one object flowed
through the pipeline per call (no additional or duplicated output object).
Every outcome matched before the correction was written.

**Smallest reproduction** (isolated, no dependency on any other part of the
script):

```powershell
function Get-SafeProperty-Buggy {
    param($Object, [string[]] $PropertyPath)
    $current = $Object
    foreach ($propertyName in $PropertyPath) {
        if ($null -eq $current) { return $null }
        $member = $current.PSObject.Properties[$propertyName]
        if ($null -eq $member) { return $null }
        $current = $member.Value
    }
    return $current
}

$obj = [pscustomobject]@{ members = @('only-one') }
$obj.members -is [array]                        # True — the real property value is a real array.
(Get-SafeProperty-Buggy -Object $obj -PropertyPath @('members')) -is [array]
# False — the one-element array collapsed to a bare string.

function Get-SafeProperty-Fixed {
    param($Object, [string[]] $PropertyPath)
    $current = $Object
    foreach ($propertyName in $PropertyPath) {
        if ($null -eq $current) { return $null }
        $member = $current.PSObject.Properties[$propertyName]
        if ($null -eq $member) { return $null }
        $current = $member.Value
    }
    Write-Output -NoEnumerate $current
    return
}
(Get-SafeProperty-Fixed -Object $obj -PropertyPath @('members')) -is [array]
# True — the array's identity is preserved.
```

**Regression coverage:** the harness's `GetSafeProperty-ArrayIdentity-regression`
scenario dot-sources the real production script in an isolated child process
(independent of the gcloud sandbox) and proves, against the real
`Get-SafeProperty`:

- **A.** A scalar property remains a scalar string, not an array.
- **B.** An explicit-null property returns `$null`.
- **C.** An empty-array property returns a real array with `Count 0`.
- **D.** A one-string array property returns `Count 1` with the original
  string at index `0`.
- **E.** A two-string array property returns `Count 2` with order preserved.
- **F.** A one-object array property returns `Count 1` with the original
  object's fields intact.
- **G.** A nested property path ending in a one-element array still
  preserves that array.
- **H.** A missing property still returns `$null`.
- **IAM-1/2.** `ConvertTo-SafeIamPolicyResult` accepts a valid policy
  containing one binding with exactly one string member, and the normalized
  `members` property remains an array with `Count 1`.
- **IAM-3.** A valid binding with multiple members still succeeds and
  preserves all members.
- **IAM-4.** A malformed scalar `members` value still fails closed — the
  correction only preserves a *genuine* array's identity; it does not
  loosen the existing scalar-rejection check.

This is deliberately in addition to, not instead of, exercising the
correction through the real, full, end-to-end preflight run: scenario B now
passes in full (exit 0, zero blockers, all 29 invocations), and G-zero,
G-one, and G-multiple all now satisfy their full, pre-existing set of exact
blocker/warning assertions — none of those assertions were weakened or
rewritten to accommodate this correction.

`privateWorkerPreflight.test.js` additionally proves statically that
`Get-SafeProperty` terminates with `Write-Output -NoEnumerate $current`
followed by a bare `return`, that the old terminal `return $current` is
absent, that the `Write-Output -NoEnumerate` call is positioned after the
traversal loop (not inside it), that no comma-array workaround, JSON
re-conversion, reflection, `Invoke-Expression`, or caller-specific branching
was introduced, and that both `Get-PropertyReadOutcome` and
`ConvertTo-DataArray` remain byte-for-byte unchanged by this correction.

Per this round's explicit scope — "if this correction exposes another
distinct production defect, stop and report its smallest reproducible case"
— the complete offline harness was rerun after this correction and produced
**zero failures**: every scenario (A through Q, all defect 1–5 regressions,
every leakage and command-containment assertion) passed. No further,
distinct production defect was exposed.

This still does not establish real Google Cloud readiness: this harness
proves runtime behavior against a synthetic, offline `gcloud` only. A clean
run of the real tool is discovery data about the state gcloud reports at
that moment — not a certification, and not a substitute for the human
review checklist in `PRIVATE_WORKER_PREFLIGHT.md`.

## Running the harness

Windows PowerShell 5.1 (the same shell the production script itself
targets) is the only supported and permitted way to execute the real
preflight script through this harness:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File privateWorkerPreflight.runtime.test.ps1
```

Output ends with a `TOTAL` / `PASSED` / `FAILED` summary. Exit codes:

- `0` — every assertion passed (this is the current result: 127/127 pass).
- `1` — the harness ran to completion but one or more assertions failed.
- `2` — the harness could not safely establish or verify the synthetic
  `gcloud` sandbox, and aborted before invoking the real script at all.

This harness has no external dependencies (no Pester, no NuGet packages) and
performs no network access, Docker usage, deployment, migration, credential
read, commit, or push.

## Current status summary

- **Static suite** (`privateWorkerPreflight.test.js`): 782/782 pass, 0
  skipped, 0 todo. Full repository `npm test`: 1471/1471 pass, 0 failed, 0
  skipped, 0 todo.
- **Runtime harness**: 127/127 assertions pass, exit code 0. Every scenario
  (A through Q), every defect 1–5 regression, and every leakage and
  command-containment assertion passes.
- Defects 1, 2, 3, 4, and 5 are all corrected and regression-covered.
- A synthetic runtime harness pass still does not establish real Google
  Cloud readiness: it proves behavior against an offline, synthetic
  `gcloud` only, and is never a substitute for
  the human review checklist in `PRIVATE_WORKER_PREFLIGHT.md`.
