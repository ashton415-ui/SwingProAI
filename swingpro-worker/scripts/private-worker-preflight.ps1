#requires -Version 5.1
# Read-only Google Cloud discovery preflight for the private analysis worker
# (Phase 2B2B3B3F). This script never mutates Google Cloud configuration: it
# only lists/describes/get-iam-policy's explicitly named resources and writes
# one JSON report. It never enables APIs, deploys services, builds images,
# changes IAM, changes secrets, changes queue state, retrieves secret
# payloads, retrieves Cloud Tasks task bodies, or retrieves access/identity
# tokens. It never reads an implicit gcloud active project.
#
# Fails closed: any generic discovery result or supplied-target result that
# is not exactly 'success' becomes a blocker (never inferred as absence when
# the cause is permission_denied). Every gcloud invocation is validated
# against an exact per-command schema (full argument structure, not just a
# leading-token prefix) before gcloud is ever resolved or invoked. Cloud Run
# list/describe requests a reviewed safe JSON projection that structurally
# cannot include container environment variables or secret references. All
# JSON property access goes through a safe accessor so a malformed or
# unexpected response shape becomes a blocker instead of an unhandled
# exception, and every command-helper failure is contained to a structured
# result rather than an uncaught exception.
#
# Executing this file directly may run discovery. Dot-sourcing this file
# (". .\private-worker-preflight.ps1") only loads its functions and must
# never trigger discovery, gcloud invocation, or report writing by itself —
# every parameter below is intentionally declared optional (no
# [Parameter(Mandatory)]) so PowerShell never blocks on an interactive
# prompt during dot-sourcing; "required" parameters are instead enforced by
# explicit validation inside Invoke-PrivateWorkerPreflightMain.
[CmdletBinding()]
param(
    [string] $ProjectId,
    [string] $Region,
    [string] $TasksLocation,
    [string] $OutputPath,
    [string] $WorkerServiceName,
    [string] $ArtifactRepository,
    [string] $QueueName,
    [string] $RuntimeServiceAccount,
    [string] $TaskCallerServiceAccount,
    [string] $TaskCreatorServiceAccount,
    [string] $SupabaseSecretName,
    [string] $GeminiSecretName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = '1.2.0'
$script:SafeErrorMaxLength = 500

$script:RequiredApis = @(
    'run.googleapis.com',
    'cloudtasks.googleapis.com',
    'artifactregistry.googleapis.com',
    'secretmanager.googleapis.com',
    'cloudbuild.googleapis.com',
    'iam.googleapis.com',
    'iamcredentials.googleapis.com',
    'serviceusage.googleapis.com'
)

# Google Cloud IAM currently exposes two built-in roles that can invoke a
# Cloud Run service: the legacy roles/run.invoker and the newer
# roles/run.servicesInvoker. Both are treated as invocation-capable for the
# worker-service IAM public-access check and for recognizing the
# task-caller identity's explicit binding.
$script:CloudRunInvocationRoles = @('roles/run.invoker', 'roles/run.servicesInvoker')

$script:AllowedStatuses = @('success', 'not_found', 'permission_denied', 'unavailable', 'failed', 'not_requested')

# Reviewed, safe JSON projections for Cloud Run service metadata. Neither
# requests the unrestricted annotations map (which can carry unrelated
# custom metadata or secret references) — instead, public-access
# disablement is read from Cloud Run v2's dedicated first-class
# `invokerIamDisabled` boolean, plus (for the targeted describe projection
# only) one single, narrowly-projected annotation map key —
# `metadata.annotations.[run.googleapis.com/invoker-iam-disabled]` — that
# still-current gcloud documentation exposes the same setting under in the
# Knative/v1-shaped resource form. This is a single bracket-selected map
# entry, never the complete annotations map: gcloud's format projection
# preserves only the one requested key, so no other annotation can ever
# reach this tool. Both structurally exclude metadata/labels,
# env/environment, value/valueFrom, secretKeyRef, secrets,
# volumes/volumeMounts, command/args, and every other unrestricted
# container-spec field. Used only for `run services list` and `run services
# describe` — never for `run services get-iam-policy`, whose response is
# already just an IAM Policy object.
#
# The generic list projection is deliberately minimal: it requests only the
# fields ConvertTo-SafeCloudRunListResult actually retains (name and
# ingress, with v1/v2 name alternatives) — not the richer runtime identity,
# container image, traffic, revision, invokerIamDisabled, or annotation
# fields that only the targeted per-service describe needs.
$script:CloudRunListSafeFormatFlag = '--format=json(name,metadata.name,ingress)'

# The targeted describe projection includes v1 and v2 field-path
# alternatives where useful: a name, a service URL, ingress, the latest
# ready revision, traffic, the runtime service-account identity, the
# container image references, the top-level invokerIamDisabled boolean, and
# the single narrowly-projected invoker-iam-disabled annotation key (the
# Knative/v1-shaped alternative form of the same setting).
$script:CloudRunDescribeSafeFormatFlag = '--format=json(name,uri,ingress,latestReadyRevision,traffic,trafficStatuses,template.serviceAccount,template.containers[].image,invokerIamDisabled,metadata.annotations.[run.googleapis.com/invoker-iam-disabled],metadata.name,status.url,status.latestReadyRevisionName,status.traffic,spec.template.spec.serviceAccountName,spec.template.spec.containers[].image)'

# Reviewed, safe JSON projection for `gcloud config list`: requests only
# the five properties this preflight ever evaluates — core/account and the
# four persisted authentication-override properties
# (auth/impersonate_service_account, auth/access_token_file,
# auth/credential_file_override, auth/disable_credentials). This
# projection deliberately excludes every other configuration section and
# property (compute, api_endpoint_overrides, proxy settings, configuration
# directories, project, etc.) — none of those are ever requested by this
# format string, and none of them are evaluated anywhere in this script.
$script:GcloudConfigListSafeFormatFlag = '--format=json(core.account,auth.impersonate_service_account,auth.access_token_file,auth.credential_file_override,auth.disable_credentials)'

# The exact, fully-structured schema for every approved read-only command
# path this tool may invoke. Test-GcloudCommandSchema validates the complete
# argument array against one of these entries — command path, positional
# argument count/value, every flag name, whether it needs a value, whether
# it may appear only once, and (for --project/--region/--location) that its
# value matches the caller-supplied ProjectId/Region/TasksLocation — not
# merely that an argument sequence starts with an approved prefix.
$script:CommandSchemas = @(
    [ordered]@{ Path = @('version'); PositionalCount = 0; PositionalEqualsProjectId = $false; RequiresProject = $false; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('auth', 'list'); PositionalCount = 0; PositionalEqualsProjectId = $false; RequiresProject = $false; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('config', 'list'); PositionalCount = 0; PositionalEqualsProjectId = $false; RequiresProject = $false; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'config-list-safe' },
    [ordered]@{ Path = @('projects', 'describe'); PositionalCount = 1; PositionalEqualsProjectId = $true; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('projects', 'get-iam-policy'); PositionalCount = 1; PositionalEqualsProjectId = $true; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('services', 'list'); PositionalCount = 0; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $true; FormatMode = 'json' },
    [ordered]@{ Path = @('artifacts', 'repositories', 'list'); PositionalCount = 0; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = '--location'; LocationExpected = 'Region'; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('artifacts', 'repositories', 'describe'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = '--location'; LocationExpected = 'Region'; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('artifacts', 'repositories', 'get-iam-policy'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = '--location'; LocationExpected = 'Region'; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('run', 'services', 'list'); PositionalCount = 0; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = '--region'; LocationExpected = 'Region'; RequiresEnabledFlag = $false; FormatMode = 'cloudrun-list-safe' },
    [ordered]@{ Path = @('run', 'services', 'describe'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = '--region'; LocationExpected = 'Region'; RequiresEnabledFlag = $false; FormatMode = 'cloudrun-describe-safe' },
    [ordered]@{ Path = @('run', 'services', 'get-iam-policy'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = '--region'; LocationExpected = 'Region'; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('iam', 'service-accounts', 'list'); PositionalCount = 0; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('iam', 'service-accounts', 'describe'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('iam', 'service-accounts', 'get-iam-policy'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('secrets', 'list'); PositionalCount = 0; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('secrets', 'describe'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('secrets', 'versions', 'list'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('secrets', 'get-iam-policy'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = $null; LocationExpected = $null; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('tasks', 'queues', 'list'); PositionalCount = 0; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = '--location'; LocationExpected = 'TasksLocation'; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('tasks', 'queues', 'describe'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = '--location'; LocationExpected = 'TasksLocation'; RequiresEnabledFlag = $false; FormatMode = 'json' },
    [ordered]@{ Path = @('tasks', 'queues', 'get-iam-policy'); PositionalCount = 1; PositionalEqualsProjectId = $false; RequiresProject = $true; LocationFlag = '--location'; LocationExpected = 'TasksLocation'; RequiresEnabledFlag = $false; FormatMode = 'json' }
)

# ----------------------------------------------------------------------
# Validation helpers
# ----------------------------------------------------------------------

function Test-ValidProjectId {
    param([string] $Value)
    if ([string]::IsNullOrEmpty($Value)) { return $false }
    return $Value -cmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
}

function Test-ValidRegionOrLocation {
    param([string] $Value)
    if ([string]::IsNullOrEmpty($Value)) { return $false }
    if ($Value.Length -gt 63) { return $false }
    return $Value -cmatch '^[a-z][a-z0-9-]*[a-z0-9]$'
}

function Test-ValidResourceName {
    param(
        [string] $Value,
        [int] $MaxLength = 128
    )
    if ([string]::IsNullOrEmpty($Value)) { return $false }
    if ($Value.Length -gt $MaxLength) { return $false }
    return $Value -cmatch '^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9]$'
}

function Test-ValidServiceAccountEmail {
    param(
        [string] $Value,
        [string] $ProjectId
    )
    if ([string]::IsNullOrEmpty($Value)) { return $false }
    if ([string]::IsNullOrEmpty($ProjectId)) { return $false }
    $escapedProjectId = [regex]::Escape($ProjectId)
    $pattern = '^[a-z][a-z0-9-]{4,28}[a-z0-9]@' + $escapedProjectId + '\.iam\.gserviceaccount\.com$'
    return $Value -cmatch $pattern
}

$script:MaxCanonicalLinkDepth = 10

# Resolves a directory to its true real/canonical location: every ancestor
# path component is inspected for a reparse point (symlink/junction), not
# just the final leaf, and a link's target is itself re-resolved from
# scratch (so a chain of consecutive links, and any reparse points among
# the target's own ancestors, are both caught). A relative link target is
# resolved against the directory containing the link. A visited-path set
# detects cycles, and a conservative maximum link-follow depth bounds
# runaway chains — both fail closed by throwing rather than returning a
# guessed path. An ancestor component that does not exist, or a reparse
# point whose target cannot be determined, also fails closed.
function Resolve-CanonicalDirectoryPath {
    param([Parameter(Mandatory)] [string] $Path)

    $linkFollowCount = 0
    $visitedLinkPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

    $current = [System.IO.Path]::GetFullPath($Path)

    while ($true) {
        $root = [System.IO.Path]::GetPathRoot($current)
        $relative = $current.Substring($root.Length)
        $separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
        $segments = New-Object System.Collections.Generic.List[string]
        foreach ($part in $relative.Split($separators)) {
            if ($part.Length -gt 0) { $segments.Add($part) | Out-Null }
        }

        # Traversal starts from the true root exactly as GetPathRoot
        # returned it (e.g. "C:\", "\\server\share\", "/") — never trimmed.
        # Stripping a drive root's trailing separator would turn "C:\" into
        # the drive-relative "C:", which is not an absolute path.
        $builtPath = $root

        $linkEncountered = $false

        for ($segmentIndex = 0; $segmentIndex -lt $segments.Count; $segmentIndex++) {
            $builtPath = Join-Path -Path $builtPath -ChildPath $segments[$segmentIndex]

            # Every component built here is itself a directory (the path
            # being resolved is always a directory), so its existence check
            # requires PathType Container specifically — this resolver must
            # never silently accept, or ultimately return, a file path.
            if (-not (Test-Path -LiteralPath $builtPath -PathType Container)) {
                throw 'OutputPath directory resolution failed: an ancestor path component does not exist or is not a directory.'
            }

            $item = Get-Item -LiteralPath $builtPath -Force
            $isReparsePoint = (([int]$item.Attributes) -band ([int][System.IO.FileAttributes]::ReparsePoint)) -ne 0

            if ($isReparsePoint) {
                # A confirmed reparse point mandates a resolvable target: if
                # reading Target throws, or the result is null, blank, or an
                # empty array, this fails closed rather than silently
                # falling through and being treated as a normal directory.
                $targetReadFailed = $false
                $target = $null
                try {
                    $target = $item.Target
                }
                catch {
                    $targetReadFailed = $true
                }

                if ($targetReadFailed) {
                    throw 'OutputPath directory resolution failed: unable to read a reparse point target.'
                }

                # A Target array must contain exactly one element to be
                # unambiguous: zero elements has nothing to select, and
                # more than one element means this resolver cannot safely
                # choose among multiple candidate targets — selecting
                # element zero from a multi-target array would silently
                # guess, which fails closed here instead. Only after
                # narrowing to exactly one element (or a non-array target)
                # is the result required to be a nonblank string; a
                # non-string scalar or object target is rejected the same
                # way. Every diagnostic here is generic and never includes
                # the target path itself.
                $targetValue = $target
                if ($targetValue -is [System.Array]) {
                    if ($targetValue.Count -eq 0) {
                        throw 'OutputPath directory resolution failed: a reparse point has no resolvable target.'
                    }
                    if ($targetValue.Count -gt 1) {
                        throw 'OutputPath directory resolution failed: a reparse point has an ambiguous multi-value target.'
                    }
                    $targetValue = $targetValue[0]
                }
                if ($targetValue -isnot [string] -or [string]::IsNullOrWhiteSpace($targetValue)) {
                    throw 'OutputPath directory resolution failed: a reparse point has no resolvable target.'
                }

                $linkFollowCount++
                if ($linkFollowCount -gt $script:MaxCanonicalLinkDepth) {
                    throw 'OutputPath directory resolution failed: exceeded the maximum allowed reparse-point depth.'
                }

                if (-not $visitedLinkPaths.Add($builtPath)) {
                    throw 'OutputPath directory resolution failed: detected a reparse-point cycle.'
                }

                if (-not [System.IO.Path]::IsPathRooted($targetValue)) {
                    $parentOfLink = Split-Path -Path $builtPath -Parent
                    $targetValue = [System.IO.Path]::GetFullPath((Join-Path -Path $parentOfLink -ChildPath $targetValue))
                }
                else {
                    $targetValue = [System.IO.Path]::GetFullPath($targetValue)
                }

                $current = $targetValue
                for ($remainingIndex = $segmentIndex + 1; $remainingIndex -lt $segments.Count; $remainingIndex++) {
                    $current = Join-Path -Path $current -ChildPath $segments[$remainingIndex]
                }
                $current = [System.IO.Path]::GetFullPath($current)

                $linkEncountered = $true
                break
            }
        }

        if (-not $linkEncountered) {
            if (-not (Test-Path -LiteralPath $builtPath -PathType Container)) {
                throw 'OutputPath directory resolution failed: the resolved destination is not a directory.'
            }
            return $builtPath
        }
    }
}

function Resolve-ValidatedOutputPath {
    param(
        [string] $Value,
        [string] $RepositoryRoot
    )

    if ([string]::IsNullOrEmpty($Value)) {
        throw 'OutputPath is required.'
    }
    if (-not [System.IO.Path]::IsPathRooted($Value)) {
        throw 'OutputPath must be an absolute file path.'
    }

    $normalized = [System.IO.Path]::GetFullPath($Value)

    if ([System.IO.Path]::GetExtension($normalized).ToLowerInvariant() -ne '.json') {
        throw 'OutputPath must use a .json extension.'
    }

    if (Test-Path -LiteralPath $normalized -PathType Container) {
        throw 'OutputPath must not be a directory.'
    }

    if (Test-Path -LiteralPath $normalized -PathType Leaf) {
        throw 'OutputPath must not already exist.'
    }

    $parentDirectory = Split-Path -Path $normalized -Parent
    if ([string]::IsNullOrEmpty($parentDirectory) -or -not (Test-Path -LiteralPath $parentDirectory -PathType Container)) {
        throw 'OutputPath parent directory must already exist.'
    }

    # Canonicalize both existing directories (the requested parent and the
    # repository root) before the containment comparison, rather than
    # comparing their lexical GetFullPath forms directly — a symlink or
    # junction can otherwise make an externally-named path resolve inside
    # the repository undetected.
    $canonicalParentDirectory = Resolve-CanonicalDirectoryPath -Path $parentDirectory
    $canonicalRepositoryRoot = Resolve-CanonicalDirectoryPath -Path $RepositoryRoot
    $canonicalOutputDestination = Join-Path -Path $canonicalParentDirectory -ChildPath (Split-Path -Path $normalized -Leaf)

    $repoRootWithSeparator = $canonicalRepositoryRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if ($canonicalOutputDestination.StartsWith($repoRootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($canonicalOutputDestination, $canonicalRepositoryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'OutputPath must not be inside the Git repository.'
    }

    # Return the canonical destination — not the original lexical path — so
    # the caller's final write goes to the same real location this
    # containment check just validated.
    return $canonicalOutputDestination
}

# ----------------------------------------------------------------------
# Safe property access (Set-StrictMode throws on a non-existent property,
# and gcloud JSON shapes are not guaranteed stable across API versions —
# every read of a parsed JSON response must go through this accessor so a
# missing or renamed field becomes $null instead of a crash.)
# ----------------------------------------------------------------------

function Get-SafeProperty {
    param(
        $Object,
        [Parameter(Mandatory)] [string[]] $PropertyPath
    )
    $current = $Object
    foreach ($propertyName in $PropertyPath) {
        if ($null -eq $current) { return $null }
        # AsPSObject($PSCustomObject) on Windows PowerShell 5.1 Desktop can
        # return the same PSCustomObject reference rather than a distinct
        # PSObject whose .Properties collection is directly accessible —
        # under Set-StrictMode that bare .Properties access then throws.
        # Every object's intrinsic .PSObject member is always safe to read
        # regardless of the underlying type (PSCustomObject, string, scalar,
        # etc.), so the property collection is read through it directly.
        $member = $current.PSObject.Properties[$propertyName]
        if ($null -eq $member) { return $null }
        $current = $member.Value
    }
    # A bare `return $current` writes $current to the success output
    # stream, and PowerShell enumerates array values placed on the
    # pipeline by default — when $current is an array with exactly one
    # element, a caller capturing this function's output into a plain
    # scalar variable receives that single element itself, not a
    # one-element array, silently losing the array's identity (the same
    # underlying pipeline behavior that made ConvertTo-DataArray necessary
    # elsewhere in this script). Write-Output -NoEnumerate places $current
    # on the pipeline as a single, unenumerated object regardless of
    # whether it is $null, a scalar, or an array of any length, so the
    # caller always receives back exactly what was stored.
    Write-Output -NoEnumerate $current
    return
}

function ConvertTo-DataArray {
    param($Data)
    if ($null -eq $Data) { return @() }
    return @($Data)
}

# ----------------------------------------------------------------------
# Safe command execution
# ----------------------------------------------------------------------

# Path-like span start patterns. The first entry covers a Windows drive
# root in either slash style (C:\Users\... or C:/Users/...), guarded by a
# negative lookbehind requiring the drive letter not be preceded by another
# alphanumeric character — this is what stops "https://" from being read as
# drive letter "s:" followed by a slash. UNC paths and file:// URIs remain
# explicit; the fourth entry is a single general absolute-POSIX-path
# pattern (covering /root/, /workspace/, /home/, /Users/, /tmp/, /var/,
# /opt/, /mnt/, /private/, and any other absolute POSIX path) guarded by
# its own negative lookbehind so the path portion of an http:// or https://
# URL is never mistaken for a local path: the character immediately before
# a qualifying '/' must not be ':', another '/', or a word character, which
# excludes every slash inside "scheme://host/path".
$script:PathRedactionStartPatterns = @(
    '(?<![A-Za-z0-9])[A-Za-z]:[\\/]',
    '\\\\[^\s"''<>|\\]',
    'file:///?',
    '(?<![:/\w])/[^\s/]'
)

function Get-SafeErrorText {
    param([string] $Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }

    # Redact local filesystem paths before anything else touches the text.
    # A path may itself contain spaces (e.g. "C:\Users\Ashton Parson\..."),
    # so once a path-like span starts, the whole remainder of that line is
    # redacted rather than stopping at the first whitespace — over-redacting
    # trailing prose on the same line is an accepted trade-off; it never
    # under-redacts and leaves part of a local path exposed.
    $redacted = $Text
    foreach ($startPattern in $script:PathRedactionStartPatterns) {
        $redacted = [regex]::Replace($redacted, "(?:$startPattern)[^\r\n]*", '[REDACTED_PATH]')
    }

    $withoutControlChars = [regex]::Replace($redacted, '[\x00-\x1F\x7F]+', ' ')
    $trimmed = $withoutControlChars.Trim()
    if ($trimmed.Length -gt $script:SafeErrorMaxLength) {
        return $trimmed.Substring(0, $script:SafeErrorMaxLength)
    }
    return $trimmed
}

function Get-GcloudErrorCategory {
    param(
        [string] $StdErrText,
        [Nullable[int]] $ExitCode
    )

    if ([string]::IsNullOrEmpty($StdErrText)) {
        return 'failed'
    }

    # Permission-denied language is checked before not-found language on
    # purpose: an identity that cannot access a resource cannot prove that
    # resource is absent, so a message combining both kinds of language
    # (e.g. "permission denied: the resource may not exist") must classify
    # as permission_denied, never not_found.
    if ($StdErrText -match '(?i)PERMISSION_DENIED|permission denied|does not have permission|Caller does not have|forbidden') {
        return 'permission_denied'
    }
    if ($StdErrText -match '(?i)NOT_FOUND|was not found|does not exist|could not be found|may not exist') {
        return 'not_found'
    }
    if ($StdErrText -match '(?i)UNAVAILABLE|could not connect|network is unreachable|failed to connect') {
        return 'unavailable'
    }
    return 'failed'
}

function New-CommandResult {
    param(
        [Parameter(Mandatory)] [string] $Id,
        [Parameter(Mandatory)] [ValidateSet('success', 'not_found', 'permission_denied', 'unavailable', 'failed', 'not_requested')] [string] $Status,
        [Nullable[int]] $ExitCode = $null,
        $Data = $null,
        [string] $ErrorCategory = $null,
        [string] $SafeError = $null
    )

    return [ordered]@{
        id            = $Id
        status        = $Status
        exitCode      = $ExitCode
        data          = $Data
        errorCategory = $ErrorCategory
        safeError     = $SafeError
    }
}

function Resolve-GcloudCommand {
    # Only an external Application or ExternalScript may be executed as
    # "gcloud" — never an alias, function, filter, or cmdlet of that name,
    # which could resolve to something other than the real Google Cloud CLI.
    # Contained: if resolution itself throws for any reason, gcloud is
    # treated as unavailable rather than letting the exception escape.
    try {
        $candidates = @(Get-Command -Name 'gcloud' -All -ErrorAction SilentlyContinue)
        $matched = @($candidates | Where-Object { $_.CommandType -eq 'Application' -or $_.CommandType -eq 'ExternalScript' })
        if ($matched.Count -eq 0) { return $null }
        return $matched[0]
    }
    catch {
        return $null
    }
}

function Find-GcloudCommandSchema {
    param([string[]] $Arguments)
    if (-not $Arguments -or $Arguments.Count -eq 0) { return $null }
    foreach ($schema in $script:CommandSchemas) {
        $path = $schema.Path
        if ($Arguments.Count -lt $path.Count) { continue }
        $isPathMatch = $true
        for ($i = 0; $i -lt $path.Count; $i++) {
            if ($Arguments[$i] -cne $path[$i]) {
                $isPathMatch = $false
                break
            }
        }
        if ($isPathMatch) { return $schema }
    }
    return $null
}

# Validates the complete argument array against the matched command's exact
# schema: command path, positional argument count (and, for the two
# project-identifying commands, that the positional value equals
# ProjectId), every flag name, value-bearing vs. switch flags, singleton
# (no-duplicate) enforcement, and that --project/--region/--location values
# equal the caller-supplied ProjectId/Region/TasksLocation. Any unrecognized
# flag — including --log-http, --log-http=true,
# --impersonate-service-account, --access-token-file,
# --credential-file-override, --configuration, --account,
# --billing-project, --flags-file, --trace-token, alpha/beta paths (which
# never match any schema path), or an extra/duplicate/mismatched instance of
# an otherwise-recognized flag — causes rejection.
function Test-GcloudCommandSchema {
    param(
        [string[]] $Arguments,
        [string] $ProjectId,
        [string] $Region,
        [string] $TasksLocation
    )

    $schema = Find-GcloudCommandSchema -Arguments $Arguments
    if ($null -eq $schema) { return $false }

    $expectedLocationValue = $null
    if ($schema.LocationExpected -eq 'Region') { $expectedLocationValue = $Region }
    elseif ($schema.LocationExpected -eq 'TasksLocation') { $expectedLocationValue = $TasksLocation }

    $expectedFormatToken = '--format=json'
    if ($schema.FormatMode -eq 'cloudrun-list-safe') { $expectedFormatToken = $script:CloudRunListSafeFormatFlag }
    elseif ($schema.FormatMode -eq 'cloudrun-describe-safe') { $expectedFormatToken = $script:CloudRunDescribeSafeFormatFlag }
    elseif ($schema.FormatMode -eq 'config-list-safe') { $expectedFormatToken = $script:GcloudConfigListSafeFormatFlag }

    $rest = New-Object System.Collections.Generic.List[string]
    for ($i = $schema.Path.Count; $i -lt $Arguments.Count; $i++) {
        $rest.Add($Arguments[$i]) | Out-Null
    }

    $positionals = New-Object System.Collections.Generic.List[string]
    $seenQuiet = 0
    $seenVerbosity = 0
    $seenFormat = 0
    $seenEnabled = 0
    $seenProject = 0
    $seenLocation = 0
    $projectValue = $null
    $locationValue = $null

    $i = 0
    while ($i -lt $rest.Count) {
        $token = $rest[$i]

        if (-not $token.StartsWith('-')) {
            $positionals.Add($token) | Out-Null
            $i++
            continue
        }

        if ($token -ceq '--quiet') {
            $seenQuiet++
            $i++
            continue
        }

        if ($token -ceq '--verbosity=error') {
            $seenVerbosity++
            $i++
            continue
        }

        if ($token -ceq $expectedFormatToken) {
            $seenFormat++
            $i++
            continue
        }

        if ($token -ceq '--enabled') {
            if (-not $schema.RequiresEnabledFlag) { return $false }
            $seenEnabled++
            $i++
            continue
        }

        if ($token -ceq '--project') {
            if (-not $schema.RequiresProject) { return $false }
            if (($i + 1) -ge $rest.Count) { return $false }
            $seenProject++
            $projectValue = $rest[$i + 1]
            $i += 2
            continue
        }

        if ($token -ceq '--region') {
            if ($schema.LocationFlag -ne '--region') { return $false }
            if (($i + 1) -ge $rest.Count) { return $false }
            $seenLocation++
            $locationValue = $rest[$i + 1]
            $i += 2
            continue
        }

        if ($token -ceq '--location') {
            if ($schema.LocationFlag -ne '--location') { return $false }
            if (($i + 1) -ge $rest.Count) { return $false }
            $seenLocation++
            $locationValue = $rest[$i + 1]
            $i += 2
            continue
        }

        # Any other flag-shaped token is rejected here: --log-http,
        # --log-http=true, --impersonate-service-account,
        # --access-token-file, --credential-file-override,
        # --configuration, --account, --billing-project, --flags-file,
        # --trace-token, a mismatched --format value, or anything else not
        # explicitly recognized above.
        return $false
    }

    if ($positionals.Count -ne $schema.PositionalCount) { return $false }
    if ($schema.PositionalEqualsProjectId -and $positionals.Count -ge 1 -and $positionals[0] -cne $ProjectId) { return $false }

    if ($seenQuiet -ne 1) { return $false }
    if ($seenVerbosity -ne 1) { return $false }
    if ($seenFormat -ne 1) { return $false }

    if ($schema.RequiresEnabledFlag) {
        if ($seenEnabled -ne 1) { return $false }
    }
    elseif ($seenEnabled -ne 0) {
        return $false
    }

    if ($schema.RequiresProject) {
        if ($seenProject -ne 1) { return $false }
        if ($projectValue -cne $ProjectId) { return $false }
    }
    elseif ($seenProject -ne 0) {
        return $false
    }

    if ($schema.LocationFlag) {
        if ($seenLocation -ne 1) { return $false }
        if ($locationValue -cne $expectedLocationValue) { return $false }
    }
    elseif ($seenLocation -ne 0) {
        return $false
    }

    return $true
}

function Invoke-ReadOnlyGcloudCommand {
    param(
        [Parameter(Mandatory)] [string] $Id,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [string[]] $Arguments,
        $GcloudCommand,
        [string] $ProjectId,
        [string] $Region,
        [string] $TasksLocation
    )

    # The entire operation is contained in one outer try/catch: temporary
    # stderr path creation, invocation, stdout capture, stderr reading, JSON
    # parsing, classification, and temporary-file cleanup can never leak an
    # unexpected exception out of this function — any unhandled failure
    # anywhere in this body returns a structured 'failed' /
    # 'command_execution_error' result instead.
    try {
        # The schema check happens first and unconditionally: an argument
        # sequence that does not match an approved command's exact schema —
        # wrong path, wrong positional count/value, an unrecognized flag, a
        # missing required flag, a duplicated singleton flag, or a
        # mismatched --project/--region/--location value — is rejected
        # before gcloud resolution is even consulted, let alone invoked.
        if (-not (Test-GcloudCommandSchema -Arguments $Arguments -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)) {
            return New-CommandResult -Id $Id -Status 'failed' -ErrorCategory 'allowlist_rejected' -SafeError 'Command rejected: argument sequence does not match an approved read-only command schema.'
        }

        if (-not $GcloudCommand) {
            return New-CommandResult -Id $Id -Status 'unavailable' -ExitCode $null -ErrorCategory 'gcloud_not_found' -SafeError 'gcloud executable was not found on PATH.'
        }

        $stderrPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("preflight-stderr-$([guid]::NewGuid().ToString('N')).txt")
        $exitCode = $null
        $stdoutText = ''
        $stderrText = ''
        $cleanupFailed = $false

        try {
            try {
                $stdoutLines = & $GcloudCommand.Source @Arguments 2> $stderrPath
                $exitCode = $LASTEXITCODE
                $stdoutText = ($stdoutLines -join "`n")
            }
            catch {
                $exitCode = -1
                $stderrText = "$($_.Exception.Message)"
            }

            if ((Test-Path -LiteralPath $stderrPath -PathType Leaf)) {
                $fileStderr = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
                if ($fileStderr) {
                    $stderrText = $stderrText + $fileStderr
                }
            }
        }
        finally {
            # The temporary file must not be silently abandoned: removal
            # uses -ErrorAction Stop so a real failure is caught (never
            # SilentlyContinue), and the outcome is recorded in
            # $cleanupFailed rather than allowed to escape this finally
            # boundary and replace whatever classified result the code
            # below would otherwise return.
            try {
                if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
                    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction Stop
                }
            }
            catch {
                $cleanupFailed = $true
            }
        }

        if ($cleanupFailed) {
            # Cleanup failure overrides any otherwise-successful
            # classification: it is reported generically, without the
            # temporary path or any raw exception, and it must reach the
            # caller as a failure so it becomes a blocker through normal
            # generic/targeted result evaluation rather than being reported
            # as success/not_found/permission_denied.
            return New-CommandResult -Id $Id -Status 'failed' -ErrorCategory 'command_execution_error' -SafeError 'Temporary diagnostic file cleanup failed.'
        }

        if ($exitCode -eq 0) {
            $parsedData = $null
            if ($stdoutText.Trim().Length -gt 0) {
                try {
                    $parsedData = $stdoutText | ConvertFrom-Json -ErrorAction Stop
                }
                catch {
                    return New-CommandResult -Id $Id -Status 'failed' -ExitCode $exitCode -ErrorCategory 'invalid_json' -SafeError 'Command output could not be parsed as JSON.'
                }
            }
            return New-CommandResult -Id $Id -Status 'success' -ExitCode $exitCode -Data $parsedData
        }

        $category = Get-GcloudErrorCategory -StdErrText $stderrText -ExitCode $exitCode
        $status = switch ($category) {
            'not_found' { 'not_found' }
            'permission_denied' { 'permission_denied' }
            'unavailable' { 'unavailable' }
            default { 'failed' }
        }

        return New-CommandResult -Id $Id -Status $status -ExitCode $exitCode -ErrorCategory $category -SafeError (Get-SafeErrorText -Text $stderrText)
    }
    catch {
        return New-CommandResult -Id $Id -Status 'failed' -ErrorCategory 'command_execution_error' -SafeError (Get-SafeErrorText -Text $_.Exception.Message)
    }
}

function New-NotRequestedResult {
    param([Parameter(Mandatory)] [string] $Id)
    return New-CommandResult -Id $Id -Status 'not_requested'
}

# Projects a successful `gcloud auth list` result down to the minimal
# reviewed account metadata this preflight needs — account identifier/email
# and active status only. Credential paths, token metadata, and any other
# unrelated account field are discarded before this result ever reaches
# report assembly (both the top-level activeAccounts field and the
# commandResults.authList entry use this projected result, never the raw
# command response). Type-safe and fully contained: any entry with a
# missing/blank/non-string account or a missing/non-string status turns the
# whole result into a structured 'failed' / 'malformed_output' result rather
# than silently accepting partial or wrongly-typed data, and an unexpected
# failure inside the projection itself is caught rather than propagated.
function ConvertTo-SafeAccountListResult {
    param($Result)
    if ($Result.status -ne 'success') {
        return $Result
    }

    try {
        $rawAccounts = ConvertTo-DataArray $Result.data
        $safeAccounts = @()

        foreach ($account in $rawAccounts) {
            $accountValue = Get-SafeProperty -Object $account -PropertyPath @('account')
            $statusValue = Get-SafeProperty -Object $account -PropertyPath @('status')

            if ($accountValue -isnot [string] -or [string]::IsNullOrWhiteSpace($accountValue)) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Authenticated account list contained an entry with no usable account identifier.'
            }
            # A blank (but present, string-typed) status may legitimately
            # represent an inactive configured account — only the type is
            # enforced here, not non-emptiness.
            if ($statusValue -isnot [string]) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Authenticated account list contained an entry with a non-string status.'
            }

            $safeAccounts += [pscustomobject]@{
                account = $accountValue
                status  = $statusValue
            }
        }

        return New-CommandResult -Id $Result.id -Status $Result.status -ExitCode $Result.exitCode -Data $safeAccounts
    }
    catch {
        return New-CommandResult -Id $Result.id -Status 'failed' -ErrorCategory 'malformed_output' -SafeError 'Authenticated account list could not be safely projected.'
    }
}

# Projects a successful `gcloud config list` result down to exactly five
# reviewed, safe fields this preflight ever evaluates: coreAccount (null or
# a nonblank string) and four booleans recording only WHETHER each
# persisted authentication-override property is configured/enabled — never
# the configured value itself. The raw parsed configuration object
# (endpoint overrides, configuration directories, project, proxy settings,
# or any other section/property) is discarded entirely and never reaches
# commandResults, targetedResources, or any report section; only this
# brand-new pscustomobject is ever stored.
#
# The response root, and the `auth`/`core` parent sections when present,
# are each explicitly validated as inspectable objects (never null treated
# as malformed, but never a scalar or array either) BEFORE any sub-property
# is read from them. This matters because Get-SafeProperty's chained-path
# traversal would otherwise silently treat a malformed (scalar/array)
# parent section the same as an absent one — reading straight through it
# and reporting every property beneath it as merely "not present". Reading
# `auth` and `core` via Get-PropertyReadOutcome first, and validating their
# shape before ever drilling into them, closes that gap: a malformed
# parent section fails the whole result closed instead of masquerading as
# "nothing configured".
#
# For each of the three string-valued auth-override properties
# (impersonate_service_account, access_token_file, credential_file_override):
# absent or null, or a blank (including whitespace-only) string, means "not
# configured" — never a blocker on its own here. A nonblank string means it
# is configured (the boolean becomes true; evaluation decides whether that
# is a blocker). Any other non-null type (object, number, boolean, array)
# is malformed configuration output and fails the WHOLE result closed —
# never silently coerced or skipped.
#
# auth/disable_credentials has its own boolean-or-boolean-like-string
# contract: absent, null, or blank means false (not enabled); an actual
# boolean is used as-is; the exact strings "true"/"True" or "false"/"False"
# are accepted and normalized; any other string, any other scalar type, an
# object, an array, or a property-access failure is malformed configuration
# output and fails the whole result closed. Its raw value is never
# serialized — only the resulting boolean.
#
# core/account keeps its existing, stricter contract: null/absent is
# accepted as "not configured" (a separate check already blocks when there
# is no active authenticated account at all), but a *present* value must be
# a nonblank string — a whitespace-only string or any other type is
# malformed configuration output and fails the whole result closed, rather
# than being compared as though it were a real account value.
function ConvertTo-SafeGcloudConfigListResult {
    param($Result)
    if ($Result.status -ne 'success') {
        return $Result
    }

    try {
        $data = $Result.data
        if ($null -eq $data -or (Test-IsScalarValue -Value $data) -or ($data -is [System.Array])) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration response was not an inspectable object.'
        }

        $authOutcome = Get-PropertyReadOutcome -Object $data -PropertyName 'auth'
        if ($authOutcome.AccessFailed) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth section could not be safely read.'
        }
        $authSection = $null
        if ($authOutcome.Found -and $null -ne $authOutcome.Value) {
            if ((Test-IsScalarValue -Value $authOutcome.Value) -or ($authOutcome.Value -is [System.Array])) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth section was not an inspectable object.'
            }
            $authSection = $authOutcome.Value
        }

        $coreOutcome = Get-PropertyReadOutcome -Object $data -PropertyName 'core'
        if ($coreOutcome.AccessFailed) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration core section could not be safely read.'
        }
        $coreSection = $null
        if ($coreOutcome.Found -and $null -ne $coreOutcome.Value) {
            if ((Test-IsScalarValue -Value $coreOutcome.Value) -or ($coreOutcome.Value -is [System.Array])) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration core section was not an inspectable object.'
            }
            $coreSection = $coreOutcome.Value
        }

        # Each of the five reviewed properties below is read via
        # Get-PropertyReadOutcome, never Get-SafeProperty: a property-access
        # failure (a hostile/misbehaving getter) must fail this result
        # closed, and Get-SafeProperty cannot report that distinctly from a
        # simple missing property — collapsing both into $null would let a
        # read failure masquerade as "not configured".
        $impersonateServiceAccountOutcome = Get-PropertyReadOutcome -Object $authSection -PropertyName 'impersonate_service_account'
        if ($impersonateServiceAccountOutcome.AccessFailed) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth/impersonate_service_account could not be safely read.'
        }
        $impersonateServiceAccountRaw = $impersonateServiceAccountOutcome.Value
        if ($null -ne $impersonateServiceAccountRaw -and $impersonateServiceAccountRaw -isnot [string]) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected auth/impersonate_service_account value type.'
        }
        $impersonateServiceAccountConfigured = ($impersonateServiceAccountRaw -is [string]) -and (-not [string]::IsNullOrWhiteSpace($impersonateServiceAccountRaw))

        $accessTokenFileOutcome = Get-PropertyReadOutcome -Object $authSection -PropertyName 'access_token_file'
        if ($accessTokenFileOutcome.AccessFailed) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth/access_token_file could not be safely read.'
        }
        $accessTokenFileRaw = $accessTokenFileOutcome.Value
        if ($null -ne $accessTokenFileRaw -and $accessTokenFileRaw -isnot [string]) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected auth/access_token_file value type.'
        }
        $accessTokenFileConfigured = ($accessTokenFileRaw -is [string]) -and (-not [string]::IsNullOrWhiteSpace($accessTokenFileRaw))

        $credentialFileOverrideOutcome = Get-PropertyReadOutcome -Object $authSection -PropertyName 'credential_file_override'
        if ($credentialFileOverrideOutcome.AccessFailed) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth/credential_file_override could not be safely read.'
        }
        $credentialFileOverrideRaw = $credentialFileOverrideOutcome.Value
        if ($null -ne $credentialFileOverrideRaw -and $credentialFileOverrideRaw -isnot [string]) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected auth/credential_file_override value type.'
        }
        $credentialFileOverrideConfigured = ($credentialFileOverrideRaw -is [string]) -and (-not [string]::IsNullOrWhiteSpace($credentialFileOverrideRaw))

        $disableCredentialsOutcome = Get-PropertyReadOutcome -Object $authSection -PropertyName 'disable_credentials'
        if ($disableCredentialsOutcome.AccessFailed) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth/disable_credentials could not be safely read.'
        }
        $disableCredentialsRaw = $disableCredentialsOutcome.Value
        $disableCredentialsEnabled = $false
        if ($null -eq $disableCredentialsRaw) {
            $disableCredentialsEnabled = $false
        }
        elseif ($disableCredentialsRaw -is [bool]) {
            $disableCredentialsEnabled = $disableCredentialsRaw
        }
        elseif ($disableCredentialsRaw -is [string]) {
            if ([string]::IsNullOrWhiteSpace($disableCredentialsRaw)) {
                $disableCredentialsEnabled = $false
            }
            elseif (($disableCredentialsRaw -ceq 'false') -or ($disableCredentialsRaw -ceq 'False')) {
                $disableCredentialsEnabled = $false
            }
            elseif (($disableCredentialsRaw -ceq 'true') -or ($disableCredentialsRaw -ceq 'True')) {
                $disableCredentialsEnabled = $true
            }
            else {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected auth/disable_credentials string value.'
            }
        }
        else {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected auth/disable_credentials value type.'
        }

        $coreAccountOutcome = Get-PropertyReadOutcome -Object $coreSection -PropertyName 'account'
        if ($coreAccountOutcome.AccessFailed) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration core/account could not be safely read.'
        }
        $coreAccountRaw = $coreAccountOutcome.Value
        if ($null -ne $coreAccountRaw -and $coreAccountRaw -isnot [string]) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected core/account value type.'
        }
        if ($coreAccountRaw -is [string] -and [string]::IsNullOrWhiteSpace($coreAccountRaw)) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained a whitespace-only core/account value.'
        }

        $normalized = [pscustomobject]@{
            coreAccount                         = $coreAccountRaw
            impersonateServiceAccountConfigured = $impersonateServiceAccountConfigured
            accessTokenFileConfigured           = $accessTokenFileConfigured
            credentialFileOverrideConfigured    = $credentialFileOverrideConfigured
            disableCredentialsEnabled           = $disableCredentialsEnabled
        }

        return New-CommandResult -Id $Result.id -Status $Result.status -ExitCode $Result.exitCode -Data $normalized
    }
    catch {
        return New-CommandResult -Id $Result.id -Status 'failed' -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration could not be safely projected.'
    }
}

# Tries each candidate property path in order (v1 and v2 field-name
# alternatives) and returns the first non-null value found — used by the
# Cloud Run normalizers below so either API shape is read safely.
function Test-IsScalarValue {
    param($Value)
    return ($Value -is [string]) -or ($Value -is [bool]) -or ($Value -is [int]) -or ($Value -is [long]) -or
    ($Value -is [double]) -or ($Value -is [decimal]) -or ($Value -is [single]) -or ($Value -is [uint32]) -or
    ($Value -is [uint64]) -or ($Value -is [byte]) -or ($Value -is [sbyte]) -or ($Value -is [int16]) -or ($Value -is [uint16])
}

# Reads a single property and returns an explicit three-way outcome rather
# than collapsing "property absent" and "property present but null" and "the
# read itself failed" into a single ambiguous $null, the way Get-SafeProperty
# does for its own (different) purpose of chained-path traversal. This
# matters because a caller distinguishing "absent" from "failed" cannot
# safely be built on top of Get-SafeProperty or a bare outer try/catch around
# it: Get-SafeProperty performs no property-value read of its own that can
# throw in a way this function's caller could observe distinctly from a
# simple missing member, so a dedicated guarded read is used instead.
# - Found=$false, Value=$null, AccessFailed=$false  => the property is absent
# - Found=$true,  Value=$null, AccessFailed=$false  => the property is present and explicitly null
# - Found=$true,  Value=<x>,   AccessFailed=$false  => the property is present with a non-null value
# - Found=$false, Value=$null, AccessFailed=$true   => the member exists but was rejected without being read
# $Object being $null is treated as the property being absent (there is
# nothing to fail to read), never as an access failure.
#
# This helper's real production inputs are reviewed plain data: parsed JSON
# (ConvertFrom-Json PSCustomObject) and internally-built [pscustomobject]
# literals. Both forms expose their fields exclusively as NoteProperty
# members — plain stored values with no getter code to run. On Windows
# PowerShell 5.1, neither `$Object.$PropertyName` dotted access nor a
# `.Properties[...].Value` read reliably surfaces a getter's exception as a
# catchable, terminating error: a hostile or misbehaving ScriptProperty or
# adapted CLR property can throw and still have that failure silently
# demoted to a non-terminating error, leaving the caller with an
# indistinguishable-from-legitimate $null. So this function never invokes
# any getter it has not first classified as safe: it inspects the member's
# MemberType via the intrinsic `.PSObject.Properties` collection (a lookup
# that never invokes the getter) and reads `.Value` only when that member is
# a NoteProperty. Any other member type — ScriptProperty, CodeProperty,
# AliasProperty, an adapted CLR Property, a ParameterizedProperty, or any
# dynamic member — is rejected as AccessFailed=$true without ever being
# invoked. This is deterministic fail-closed handling: it does not depend on
# whether a given getter's exception happens to be catchable, and it never
# executes untrusted computed/executable member code.
function Get-PropertyReadOutcome {
    param(
        $Object,
        [Parameter(Mandatory)] [string] $PropertyName
    )
    if ($null -eq $Object) {
        return [pscustomobject]@{ Found = $false; Value = $null; AccessFailed = $false }
    }
    try {
        $member = $Object.PSObject.Properties[$PropertyName]
        if ($null -eq $member) {
            return [pscustomobject]@{ Found = $false; Value = $null; AccessFailed = $false }
        }
        # Only a NoteProperty — a plain stored value with no getter code —
        # is ever read. Every other member type is rejected here, before
        # any invocation, so a hostile or misbehaving getter is never run.
        if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) {
            return [pscustomobject]@{ Found = $false; Value = $null; AccessFailed = $true }
        }
        $value = $member.Value
        return [pscustomobject]@{ Found = $true; Value = $value; AccessFailed = $false }
    }
    catch {
        return [pscustomobject]@{ Found = $false; Value = $null; AccessFailed = $true }
    }
}

# An IAM allow-policy binding with a `condition` is only granted when that
# condition's CEL expression evaluates true at request time — this preflight
# never evaluates IAM conditions, so a conditional binding can never be
# automated proof of an unconditionally-required permission. A binding is
# treated as unconditional only when its `condition` property is absent or
# explicitly null; any present non-null condition value — including an empty
# or otherwise malformed condition object — is treated as conditional and
# rejected as proof. A malformed binding itself (null, or a scalar rather
# than an inspectable object) is never treated as unconditional. A
# property-access failure fails closed (never accepted as proof) rather than
# being treated as unconditional — this is determined via the explicit
# AccessFailed outcome above, never by mistaking a failed read for an absent
# property.
function Test-IsUnconditionalBinding {
    param($Binding)
    if ($null -eq $Binding -or (Test-IsScalarValue -Value $Binding)) {
        return $false
    }

    $outcome = Get-PropertyReadOutcome -Object $Binding -PropertyName 'condition'
    if ($outcome.AccessFailed) {
        return $false
    }
    if (-not $outcome.Found) {
        return $true
    }
    return $null -eq $outcome.Value
}

# Projects a successful `gcloud ... get-iam-policy` result into a
# brand-new, reviewed policy object before it is ever stored in
# commandResults, placed into targetedResources, or read by any blocker
# evaluation. This is applied to every one of the nine get-iam-policy
# results this script retrieves (project, worker service, artifact
# repository, queue, runtime/task-caller/task-creator service accounts, and
# the two supplied secrets) — the raw IAM Policy object (etag,
# auditConfigs, condition title/description/CEL expression, or any other
# unreviewed property) never reaches the report under any of them.
#
# The policy root must be a non-null inspectable object — a scalar or array
# root is malformed. `bindings` may be absent or null, which normalizes to
# an empty bindings array; when present it must represent a collection of
# inspectable binding objects, never a scalar. Each binding must carry a
# nonblank string `role` and at least one nonblank string `member`;
# anything else fails the WHOLE policy closed rather than dropping just the
# one malformed binding, so a partially-malformed policy can never be
# mistaken for a smaller, valid one.
#
# Each binding's `condition` is read via Get-PropertyReadOutcome (not
# Get-SafeProperty) so a property-access failure is distinguished from
# absence and fails closed. Absent or explicitly null normalizes to
# `$null` (unconditional). A present, non-null condition must itself be an
# inspectable object (a scalar condition is malformed); when valid, it is
# never retained as-is — only a brand-new, opaque, non-null marker object
# is stored in its place, carrying no title, description, CEL expression,
# or any other raw condition property. This preserves exactly the contract
# Test-IsUnconditionalBinding already relies on: `$null` means
# unconditional, and any non-null value (now guaranteed to be this safe
# marker, never a raw condition) means conditional.
function ConvertTo-SafeIamPolicyResult {
    param($Result)
    if ($Result.status -ne 'success') {
        return $Result
    }

    try {
        $data = $Result.data
        if ($null -eq $data -or (Test-IsScalarValue -Value $data) -or ($data -is [System.Array])) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy response was not an inspectable object.'
        }

        $bindingsOutcome = Get-PropertyReadOutcome -Object $data -PropertyName 'bindings'
        if ($bindingsOutcome.AccessFailed) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy bindings could not be safely read.'
        }

        $normalizedBindings = @()
        if ($bindingsOutcome.Found -and $null -ne $bindingsOutcome.Value) {
            $bindingsRaw = $bindingsOutcome.Value
            if (Test-IsScalarValue -Value $bindingsRaw) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy bindings was not a collection of binding objects.'
            }

            foreach ($binding in (ConvertTo-DataArray $bindingsRaw)) {
                if ($null -eq $binding -or (Test-IsScalarValue -Value $binding)) {
                    return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry that is not an inspectable object.'
                }

                $role = Get-SafeProperty -Object $binding -PropertyPath @('role')
                if ($role -isnot [string] -or [string]::IsNullOrWhiteSpace($role)) {
                    return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry with no usable role.'
                }

                $membersRaw = Get-SafeProperty -Object $binding -PropertyPath @('members')
                if ($null -eq $membersRaw -or (Test-IsScalarValue -Value $membersRaw)) {
                    return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry with no usable members.'
                }

                $members = @()
                foreach ($member in (ConvertTo-DataArray $membersRaw)) {
                    if ($member -isnot [string] -or [string]::IsNullOrWhiteSpace($member)) {
                        return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry with a non-string or blank member.'
                    }
                    $members += $member
                }
                if ($members.Count -eq 0) {
                    return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry with no usable member.'
                }

                $conditionOutcome = Get-PropertyReadOutcome -Object $binding -PropertyName 'condition'
                if ($conditionOutcome.AccessFailed) {
                    return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy binding condition could not be safely read.'
                }

                $normalizedCondition = $null
                if ($conditionOutcome.Found -and $null -ne $conditionOutcome.Value) {
                    # A condition must be exactly one inspectable condition
                    # object — a scalar (string/number/boolean) and an
                    # array (including an empty array) are both rejected
                    # here, never coerced or unwrapped to a single element.
                    if ((Test-IsScalarValue -Value $conditionOutcome.Value) -or ($conditionOutcome.Value -is [System.Array])) {
                        return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy binding condition was not an inspectable object.'
                    }
                    # A brand-new, opaque marker — never the raw condition
                    # object. No title, description, or CEL expression is
                    # ever retained; only its non-null presence matters to
                    # Test-IsUnconditionalBinding.
                    $normalizedCondition = [pscustomobject]@{ present = $true }
                }

                $normalizedBindings += [pscustomobject]@{
                    role      = $role
                    members   = $members
                    condition = $normalizedCondition
                }
            }
        }

        $normalizedPolicy = [pscustomobject]@{
            bindings = $normalizedBindings
        }

        return New-CommandResult -Id $Result.id -Status $Result.status -ExitCode $Result.exitCode -Data $normalizedPolicy
    }
    catch {
        return New-CommandResult -Id $Result.id -Status 'failed' -ErrorCategory 'malformed_output' -SafeError 'IAM policy could not be safely projected.'
    }
}

# A `gcloud secrets versions list` entry is structurally valid only when it
# is an inspectable object (never null, never a scalar), its `state` is a
# string, its `name` is a string, and that name ends with a plain
# positive-integer `/versions/<N>` segment — this rejects `latest`, any
# other alias, `/versions/0`, a negative/signed value, and a missing or
# non-string state or name. This check is independent of the entry's actual
# state value: even a structurally sound but non-ENABLED entry (e.g.
# DISABLED) is "valid" here — separately requiring at least one such valid
# entry to also be ENABLED is the caller's responsibility.
function Test-IsValidSecretVersionEntry {
    param($VersionEntry)
    if ($null -eq $VersionEntry -or (Test-IsScalarValue -Value $VersionEntry)) {
        return $false
    }
    $state = Get-SafeProperty -Object $VersionEntry -PropertyPath @('state')
    $name = Get-SafeProperty -Object $VersionEntry -PropertyPath @('name')
    return ($state -is [string]) -and ($name -is [string]) -and ($name -cmatch '/versions/[1-9][0-9]*$')
}

function Get-CloudRunFieldValue {
    param(
        $Data,
        $PropertyPathAlternatives
    )
    foreach ($path in $PropertyPathAlternatives) {
        $value = Get-SafeProperty -Object $Data -PropertyPath $path
        if ($null -ne $value) { return $value }
    }
    return $null
}

# Normalizes a successful `gcloud run services list` result into an array of
# brand-new, reviewed objects (name and ingress only) — the raw parsed
# gcloud object is discarded entirely, so any field gcloud unexpectedly
# includes beyond the requested projection can never reach report assembly.
# At minimum requires every entry to carry a non-empty name; any entry that
# doesn't turns the whole list result into 'failed' / 'malformed_output'.
function ConvertTo-SafeCloudRunListResult {
    param($Result)

    if ($Result.status -ne 'success') {
        return $Result
    }

    try {
        $rawServices = ConvertTo-DataArray $Result.data
        $safeServices = @()

        foreach ($service in $rawServices) {
            $name = Get-CloudRunFieldValue -Data $service -PropertyPathAlternatives @(@('name'), @('metadata', 'name'))
            if ($name -isnot [string] -or [string]::IsNullOrWhiteSpace($name)) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service list contained an entry with no usable service name.'
            }

            $ingress = Get-CloudRunFieldValue -Data $service -PropertyPathAlternatives @(@('ingress'))
            if ($null -ne $ingress -and $ingress -isnot [string]) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service list contained an entry with an unexpected ingress value type.'
            }

            $safeServices += [pscustomobject]@{
                name    = $name
                ingress = $ingress
            }
        }

        return New-CommandResult -Id $Result.id -Status $Result.status -ExitCode $Result.exitCode -Data $safeServices
    }
    catch {
        return New-CommandResult -Id $Result.id -Status 'failed' -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service list could not be safely projected.'
    }
}

# Normalizes a successful `gcloud run services describe` result into one
# brand-new, reviewed object exposing only: name, url, ingress,
# invokerIamDisabled, runtimeServiceAccount, containerImages,
# latestReadyRevision, and traffic. The raw parsed gcloud object — including
# the annotations map/object — is discarded entirely; only the single
# normalized invokerIamDisabled boolean is ever retained. Because this
# command is only ever invoked when WorkerServiceName is supplied,
# invokerIamDisabled must be derivable as an actual boolean from at least
# one of its two supported source forms (the v2 top-level field or the
# single narrowly-projected v1/Knative annotation entry) — gcloud can
# silently omit an unknown or unavailable projected field, so a value that
# is missing from both sources, malformed in either source, or disagreeing
# between the two sources, is treated as malformed metadata, never as
# false. When RuntimeServiceAccount was also supplied, a non-empty
# runtimeServiceAccount is required too (a mismatch between the two is a
# separate, semantic check performed later during evaluation).
function ConvertTo-SafeCloudRunDescribeResult {
    param(
        $Result,
        [string] $RuntimeServiceAccount
    )

    if ($Result.status -ne 'success') {
        return $Result
    }

    try {
        $data = $Result.data

        $name = Get-CloudRunFieldValue -Data $data -PropertyPathAlternatives @(@('name'), @('metadata', 'name'))
        if ($name -isnot [string] -or [string]::IsNullOrWhiteSpace($name)) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description did not contain a usable service name.'
        }

        # invokerIamDisabled has two supported source forms that must be
        # reconciled into a single normalized boolean report field, and the
        # raw annotations map/object is never itself retained:
        # - the Cloud Run v2 top-level `invokerIamDisabled` boolean, and
        # - the Knative/v1-shaped `metadata.annotations.[run.googleapis.com/invoker-iam-disabled]`
        #   single narrowly-projected annotation entry, whose value (when
        #   present) must be exactly the lowercase string "true" or "false"
        #   — any other type or casing is malformed, never coerced.
        # Neither source existing, either source having a malformed
        # type/value, or the two sources disagreeing are all malformed
        # output; a missing field is never interpreted as false.
        $invokerIamDisabledRaw = Get-CloudRunFieldValue -Data $data -PropertyPathAlternatives @(@('invokerIamDisabled'))
        $topLevelInvokerIamDisabledPresent = $invokerIamDisabledRaw -is [bool]
        if (($null -ne $invokerIamDisabledRaw) -and (-not $topLevelInvokerIamDisabledPresent)) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description did not contain a boolean invokerIamDisabled value.'
        }

        $invokerIamDisabledAnnotationRaw = Get-SafeProperty -Object $data -PropertyPath @('metadata', 'annotations', 'run.googleapis.com/invoker-iam-disabled')
        $annotationInvokerIamDisabledPresent = ($invokerIamDisabledAnnotationRaw -is [string]) -and (($invokerIamDisabledAnnotationRaw -ceq 'true') -or ($invokerIamDisabledAnnotationRaw -ceq 'false'))
        if (($null -ne $invokerIamDisabledAnnotationRaw) -and (-not $annotationInvokerIamDisabledPresent)) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained an invoker-iam-disabled annotation that was not the lowercase string true or false.'
        }

        if ((-not $topLevelInvokerIamDisabledPresent) -and (-not $annotationInvokerIamDisabledPresent)) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description did not contain a usable invokerIamDisabled value from either the top-level field or the annotation.'
        }

        $annotationInvokerIamDisabledBoolValue = $null
        if ($annotationInvokerIamDisabledPresent) {
            $annotationInvokerIamDisabledBoolValue = ($invokerIamDisabledAnnotationRaw -ceq 'true')
        }

        if ($topLevelInvokerIamDisabledPresent -and $annotationInvokerIamDisabledPresent -and ($invokerIamDisabledRaw -ne $annotationInvokerIamDisabledBoolValue)) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description invokerIamDisabled value disagreed between the top-level field and the annotation.'
        }

        if ($topLevelInvokerIamDisabledPresent) {
            $invokerIamDisabledNormalized = $invokerIamDisabledRaw
        }
        else {
            $invokerIamDisabledNormalized = $annotationInvokerIamDisabledBoolValue
        }

        # runtimeServiceAccount: null or a non-blank string. Both rules are
        # unconditional and apply regardless of whether -RuntimeServiceAccount
        # was supplied: a present-but-wrongly-typed value is always
        # malformed, and a whitespace-only string is always malformed too —
        # it must never be normalized into the report as if it were a
        # usable identity just because the caller happened not to supply
        # -RuntimeServiceAccount. When -RuntimeServiceAccount was supplied,
        # the normalized value must additionally be present (non-null); the
        # later semantic equality check against the supplied value remains
        # unchanged.
        $runtimeServiceAccount = Get-CloudRunFieldValue -Data $data -PropertyPathAlternatives @(@('template', 'serviceAccount'), @('spec', 'template', 'spec', 'serviceAccountName'))
        if ($null -ne $runtimeServiceAccount -and $runtimeServiceAccount -isnot [string]) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained an unexpected runtime service-account value type.'
        }
        if ($null -ne $runtimeServiceAccount -and [string]::IsNullOrWhiteSpace($runtimeServiceAccount)) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a whitespace-only runtime service-account value.'
        }
        if ($RuntimeServiceAccount -and $null -eq $runtimeServiceAccount) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description did not contain a usable runtime service-account identity.'
        }

        # url, ingress, latestReadyRevision: null or string only.
        $url = Get-CloudRunFieldValue -Data $data -PropertyPathAlternatives @(@('uri'), @('status', 'url'))
        if ($null -ne $url -and $url -isnot [string]) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained an unexpected url value type.'
        }

        $ingress = Get-CloudRunFieldValue -Data $data -PropertyPathAlternatives @(@('ingress'))
        if ($null -ne $ingress -and $ingress -isnot [string]) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained an unexpected ingress value type.'
        }

        $latestReadyRevision = Get-CloudRunFieldValue -Data $data -PropertyPathAlternatives @(@('latestReadyRevision'), @('status', 'latestReadyRevisionName'))
        if ($null -ne $latestReadyRevision -and $latestReadyRevision -isnot [string]) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained an unexpected latestReadyRevision value type.'
        }

        # containerImages: containerImagesRaw may legitimately be null; when
        # non-null it must be an object/collection of objects — a scalar
        # string/number/boolean is rejected outright, and so is any entry
        # inside the collection that is itself a scalar (not an inspectable
        # object). Every retained entry must carry a non-blank string
        # `image` — a missing or null image is rejected rather than
        # silently skipped, so a malformed entry can never quietly vanish
        # from the projected list.
        $containerImagesRaw = Get-CloudRunFieldValue -Data $data -PropertyPathAlternatives @(@('template', 'containers'), @('spec', 'template', 'spec', 'containers'))
        if ($null -ne $containerImagesRaw -and (Test-IsScalarValue -Value $containerImagesRaw)) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a non-collection container list value.'
        }
        $containerImages = @()
        foreach ($container in (ConvertTo-DataArray $containerImagesRaw)) {
            if ($null -eq $container -or (Test-IsScalarValue -Value $container)) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a container entry that is not an inspectable object.'
            }
            $image = Get-SafeProperty -Object $container -PropertyPath @('image')
            if ($null -eq $image -or $image -isnot [string] -or [string]::IsNullOrWhiteSpace($image)) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a container entry with no usable image reference.'
            }
            $containerImages += $image
        }

        # traffic: build entirely new reviewed objects only — revisionName
        # is null or string (supporting the v1 revisionName and v2 revision
        # field-name alternatives), percent is null or a finite numeric
        # scalar (NaN and +/-Infinity are rejected, not merely non-numeric
        # types). trafficRaw may be null; when non-null it must be an
        # object/collection of objects, and every entry inside it must
        # itself be an inspectable object, never a scalar. An entry where
        # every reviewed field is absent is rejected rather than normalized
        # into an all-null placeholder object.
        $trafficRaw = Get-CloudRunFieldValue -Data $data -PropertyPathAlternatives @(@('traffic'), @('trafficStatuses'), @('status', 'traffic'))
        if ($null -ne $trafficRaw -and (Test-IsScalarValue -Value $trafficRaw)) {
            return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a non-collection traffic value.'
        }
        $traffic = @()
        foreach ($trafficEntry in (ConvertTo-DataArray $trafficRaw)) {
            if ($null -eq $trafficEntry -or (Test-IsScalarValue -Value $trafficEntry)) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a traffic entry that is not an inspectable object.'
            }

            $revisionName = Get-CloudRunFieldValue -Data $trafficEntry -PropertyPathAlternatives @(@('revisionName'), @('revision'))
            if ($null -ne $revisionName -and $revisionName -isnot [string]) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a traffic entry with an unexpected revisionName value type.'
            }

            $percent = Get-SafeProperty -Object $trafficEntry -PropertyPath @('percent')
            $percentIsNumeric = ($percent -is [int]) -or ($percent -is [long]) -or ($percent -is [double]) -or ($percent -is [decimal]) -or ($percent -is [single]) -or ($percent -is [uint32]) -or ($percent -is [uint64])
            if ($null -ne $percent -and -not $percentIsNumeric) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a traffic entry with an unexpected percent value type.'
            }
            if ($percentIsNumeric) {
                $percentAsDouble = [double]$percent
                if ([double]::IsNaN($percentAsDouble) -or [double]::IsInfinity($percentAsDouble)) {
                    return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a traffic entry with a non-finite percent value.'
                }
            }

            if ($null -eq $revisionName -and $null -eq $percent) {
                return New-CommandResult -Id $Result.id -Status 'failed' -ExitCode $Result.exitCode -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description contained a traffic entry with no reviewed fields present.'
            }

            $traffic += [pscustomobject]@{
                revisionName = $revisionName
                percent      = $percent
            }
        }

        $normalized = [pscustomobject]@{
            name                  = $name
            url                   = $url
            ingress               = $ingress
            invokerIamDisabled    = $invokerIamDisabledNormalized
            runtimeServiceAccount = $runtimeServiceAccount
            containerImages       = $containerImages
            latestReadyRevision   = $latestReadyRevision
            traffic               = $traffic
        }

        return New-CommandResult -Id $Result.id -Status $Result.status -ExitCode $Result.exitCode -Data $normalized
    }
    catch {
        return New-CommandResult -Id $Result.id -Status 'failed' -ErrorCategory 'malformed_output' -SafeError 'Cloud Run service description could not be safely projected.'
    }
}

# ----------------------------------------------------------------------
# Fail-closed blocker helpers
# ----------------------------------------------------------------------

function Add-GenericDiscoveryBlocker {
    param(
        [Parameter(Mandatory)] $Result,
        [Parameter(Mandatory)] [string] $Label,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[string]] $Blockers
    )
    if ($Result.status -ne 'success') {
        $Blockers.Add("generic discovery incomplete: $Label (status: $($Result.status))") | Out-Null
    }
}

function Add-TargetVerificationBlockers {
    param(
        [Parameter(Mandatory)] [string] $Label,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[string]] $Blockers,
        [Parameter(Mandatory)] [System.Collections.Specialized.OrderedDictionary] $Results
    )
    foreach ($commandId in $Results.Keys) {
        $result = $Results[$commandId]
        if ($result.status -eq 'not_found') {
            $Blockers.Add("missing supplied target resource: $Label") | Out-Null
        }
        elseif ($result.status -ne 'success') {
            # permission_denied, unavailable, failed, or anything else: the
            # target's absence is never inferred here, only that it could
            # not be fully verified.
            $Blockers.Add("supplied target could not be fully verified: $Label ($commandId status=$($result.status))") | Out-Null
        }
    }
}

# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

function Invoke-PrivateWorkerPreflightMain {
    param(
        [string] $ProjectId,
        [string] $Region,
        [string] $TasksLocation,
        [string] $OutputPath,
        [string] $WorkerServiceName,
        [string] $ArtifactRepository,
        [string] $QueueName,
        [string] $RuntimeServiceAccount,
        [string] $TaskCallerServiceAccount,
        [string] $TaskCreatorServiceAccount,
        [string] $SupabaseSecretName,
        [string] $GeminiSecretName,
        [string] $RepositoryRoot
    )

    # ---- Local validation (exit 3 on failure; no cloud discovery yet) ----
    try {
        if (-not (Test-ValidProjectId -Value $ProjectId)) {
            throw 'ProjectId is missing or invalid.'
        }
        if (-not (Test-ValidRegionOrLocation -Value $Region)) {
            throw 'Region is missing or invalid.'
        }
        if (-not (Test-ValidRegionOrLocation -Value $TasksLocation)) {
            throw 'TasksLocation is missing or invalid.'
        }

        $resolvedOutputPath = Resolve-ValidatedOutputPath -Value $OutputPath -RepositoryRoot $RepositoryRoot

        if ($WorkerServiceName -and -not (Test-ValidResourceName -Value $WorkerServiceName -MaxLength 63)) {
            throw 'WorkerServiceName is invalid.'
        }
        if ($ArtifactRepository -and -not (Test-ValidResourceName -Value $ArtifactRepository -MaxLength 63)) {
            throw 'ArtifactRepository is invalid.'
        }
        if ($QueueName -and -not (Test-ValidResourceName -Value $QueueName -MaxLength 100)) {
            throw 'QueueName is invalid.'
        }
        if ($SupabaseSecretName -and -not (Test-ValidResourceName -Value $SupabaseSecretName -MaxLength 255)) {
            throw 'SupabaseSecretName is invalid.'
        }
        if ($GeminiSecretName -and -not (Test-ValidResourceName -Value $GeminiSecretName -MaxLength 255)) {
            throw 'GeminiSecretName is invalid.'
        }
        if ($RuntimeServiceAccount -and -not (Test-ValidServiceAccountEmail -Value $RuntimeServiceAccount -ProjectId $ProjectId)) {
            throw 'RuntimeServiceAccount is invalid or does not match ProjectId domain.'
        }
        if ($TaskCallerServiceAccount -and -not (Test-ValidServiceAccountEmail -Value $TaskCallerServiceAccount -ProjectId $ProjectId)) {
            throw 'TaskCallerServiceAccount is invalid or does not match ProjectId domain.'
        }
        if ($TaskCreatorServiceAccount -and -not (Test-ValidServiceAccountEmail -Value $TaskCreatorServiceAccount -ProjectId $ProjectId)) {
            throw 'TaskCreatorServiceAccount is invalid or does not match ProjectId domain.'
        }
    }
    catch {
        # Never use Write-Error here: with $ErrorActionPreference = 'Stop' it
        # would itself become a terminating error and escape this catch
        # block before `return 3` runs, corrupting the exit code this path
        # exists to guarantee. [Console]::Error.WriteLine is a plain,
        # non-terminating diagnostic write.
        [Console]::Error.WriteLine("Preflight local validation failed: $(Get-SafeErrorText -Text $_.Exception.Message)")
        return 3
    }

    $gcloudCommand = Resolve-GcloudCommand

    $blockers = New-Object System.Collections.Generic.List[string]
    $warnings = New-Object System.Collections.Generic.List[string]
    $commandResults = [ordered]@{}

    function Add-Result([string] $key, $result) {
        $commandResults[$key] = $result
        return $result
    }

    # ---- Generic discovery (unconditional; every call is itself
    # exception-safe via Invoke-ReadOnlyGcloudCommand) ----
    $versionResult = Add-Result 'gcloudVersion' (Invoke-ReadOnlyGcloudCommand -Id 'gcloudVersion' -Arguments @('version', '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)

    $authListResult = Add-Result 'authList' (ConvertTo-SafeAccountListResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'authList' -Arguments @('auth', 'list', '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation))

    # Read-only local configuration inventory: surfaces persisted
    # configuration-file overrides (auth/impersonate_service_account,
    # auth/access_token_file, auth/credential_file_override,
    # auth/disable_credentials) that can silently change which identity or
    # credential every other gcloud invocation in this script actually
    # uses, without appearing anywhere in gcloud auth list. The projection
    # deliberately excludes and never evaluates api_endpoint_overrides or
    # any other configuration section/property.
    $configListResult = Add-Result 'configList' (ConvertTo-SafeGcloudConfigListResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'configList' -Arguments @('config', 'list', '--quiet', '--verbosity=error', $script:GcloudConfigListSafeFormatFlag) -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation))

    $projectDescribeResult = Add-Result 'projectDescribe' (Invoke-ReadOnlyGcloudCommand -Id 'projectDescribe' -Arguments @('projects', 'describe', $ProjectId, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)

    $projectIamPolicyResult = Add-Result 'projectIamPolicy' (ConvertTo-SafeIamPolicyResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'projectIamPolicy' -Arguments @('projects', 'get-iam-policy', $ProjectId, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation))

    $enabledServicesResult = Add-Result 'enabledServices' (Invoke-ReadOnlyGcloudCommand -Id 'enabledServices' -Arguments @('services', 'list', '--enabled', '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)

    $artifactRepositoriesResult = Add-Result 'artifactRepositories' (Invoke-ReadOnlyGcloudCommand -Id 'artifactRepositories' -Arguments @('artifacts', 'repositories', 'list', '--project', $ProjectId, '--location', $Region, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)

    $cloudRunServicesResult = Add-Result 'cloudRunServices' (ConvertTo-SafeCloudRunListResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'cloudRunServices' -Arguments @('run', 'services', 'list', '--project', $ProjectId, '--region', $Region, '--quiet', '--verbosity=error', $script:CloudRunListSafeFormatFlag) -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation))

    $serviceAccountsResult = Add-Result 'serviceAccounts' (Invoke-ReadOnlyGcloudCommand -Id 'serviceAccounts' -Arguments @('iam', 'service-accounts', 'list', '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)

    $secretsListResult = Add-Result 'secrets' (Invoke-ReadOnlyGcloudCommand -Id 'secrets' -Arguments @('secrets', 'list', '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)

    $taskQueuesResult = Add-Result 'taskQueues' (Invoke-ReadOnlyGcloudCommand -Id 'taskQueues' -Arguments @('tasks', 'queues', 'list', '--project', $ProjectId, '--location', $TasksLocation, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)

    # ---- Optional targeted discovery (unconditional per supplied target) ----
    $targetedResources = [ordered]@{}

    if ($WorkerServiceName) {
        $workerServiceDescribeResult = ConvertTo-SafeCloudRunDescribeResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'workerServiceDescribe' -Arguments @('run', 'services', 'describe', $WorkerServiceName, '--project', $ProjectId, '--region', $Region, '--quiet', '--verbosity=error', $script:CloudRunDescribeSafeFormatFlag) -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation) -RuntimeServiceAccount $RuntimeServiceAccount
        $workerServiceIamPolicyResult = ConvertTo-SafeIamPolicyResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'workerServiceIamPolicy' -Arguments @('run', 'services', 'get-iam-policy', $WorkerServiceName, '--project', $ProjectId, '--region', $Region, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)
        Add-Result 'workerServiceDescribe' $workerServiceDescribeResult | Out-Null
        Add-Result 'workerServiceIamPolicy' $workerServiceIamPolicyResult | Out-Null
        $targetedResources['workerService'] = [ordered]@{ describe = $workerServiceDescribeResult; iamPolicy = $workerServiceIamPolicyResult }
    }
    else {
        $warnings.Add('target optional parameter not supplied: WorkerServiceName') | Out-Null
        Add-Result 'workerServiceDescribe' (New-NotRequestedResult -Id 'workerServiceDescribe') | Out-Null
        Add-Result 'workerServiceIamPolicy' (New-NotRequestedResult -Id 'workerServiceIamPolicy') | Out-Null
    }

    if ($ArtifactRepository) {
        $artifactRepositoryDescribeResult = Invoke-ReadOnlyGcloudCommand -Id 'artifactRepositoryDescribe' -Arguments @('artifacts', 'repositories', 'describe', $ArtifactRepository, '--project', $ProjectId, '--location', $Region, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation
        $artifactRepositoryIamPolicyResult = ConvertTo-SafeIamPolicyResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'artifactRepositoryIamPolicy' -Arguments @('artifacts', 'repositories', 'get-iam-policy', $ArtifactRepository, '--project', $ProjectId, '--location', $Region, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)
        Add-Result 'artifactRepositoryDescribe' $artifactRepositoryDescribeResult | Out-Null
        Add-Result 'artifactRepositoryIamPolicy' $artifactRepositoryIamPolicyResult | Out-Null
        $targetedResources['artifactRepository'] = [ordered]@{ describe = $artifactRepositoryDescribeResult; iamPolicy = $artifactRepositoryIamPolicyResult }
    }
    else {
        $warnings.Add('target optional parameter not supplied: ArtifactRepository') | Out-Null
        Add-Result 'artifactRepositoryDescribe' (New-NotRequestedResult -Id 'artifactRepositoryDescribe') | Out-Null
        Add-Result 'artifactRepositoryIamPolicy' (New-NotRequestedResult -Id 'artifactRepositoryIamPolicy') | Out-Null
    }

    if ($QueueName) {
        $queueDescribeResult = Invoke-ReadOnlyGcloudCommand -Id 'queueDescribe' -Arguments @('tasks', 'queues', 'describe', $QueueName, '--project', $ProjectId, '--location', $TasksLocation, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation
        $queueIamPolicyResult = ConvertTo-SafeIamPolicyResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'queueIamPolicy' -Arguments @('tasks', 'queues', 'get-iam-policy', $QueueName, '--project', $ProjectId, '--location', $TasksLocation, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)
        Add-Result 'queueDescribe' $queueDescribeResult | Out-Null
        Add-Result 'queueIamPolicy' $queueIamPolicyResult | Out-Null
        $targetedResources['queue'] = [ordered]@{ describe = $queueDescribeResult; iamPolicy = $queueIamPolicyResult }
    }
    else {
        $warnings.Add('target optional parameter not supplied: QueueName') | Out-Null
        Add-Result 'queueDescribe' (New-NotRequestedResult -Id 'queueDescribe') | Out-Null
        Add-Result 'queueIamPolicy' (New-NotRequestedResult -Id 'queueIamPolicy') | Out-Null
    }

    if ($RuntimeServiceAccount) {
        $runtimeServiceAccountDescribeResult = Invoke-ReadOnlyGcloudCommand -Id 'runtimeServiceAccountDescribe' -Arguments @('iam', 'service-accounts', 'describe', $RuntimeServiceAccount, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation
        $runtimeServiceAccountIamPolicyResult = ConvertTo-SafeIamPolicyResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'runtimeServiceAccountIamPolicy' -Arguments @('iam', 'service-accounts', 'get-iam-policy', $RuntimeServiceAccount, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)
        Add-Result 'runtimeServiceAccountDescribe' $runtimeServiceAccountDescribeResult | Out-Null
        Add-Result 'runtimeServiceAccountIamPolicy' $runtimeServiceAccountIamPolicyResult | Out-Null
        $targetedResources['runtimeServiceAccount'] = [ordered]@{ describe = $runtimeServiceAccountDescribeResult; iamPolicy = $runtimeServiceAccountIamPolicyResult }
    }
    else {
        $warnings.Add('target optional parameter not supplied: RuntimeServiceAccount') | Out-Null
        Add-Result 'runtimeServiceAccountDescribe' (New-NotRequestedResult -Id 'runtimeServiceAccountDescribe') | Out-Null
        Add-Result 'runtimeServiceAccountIamPolicy' (New-NotRequestedResult -Id 'runtimeServiceAccountIamPolicy') | Out-Null
    }

    if ($TaskCallerServiceAccount) {
        $taskCallerServiceAccountDescribeResult = Invoke-ReadOnlyGcloudCommand -Id 'taskCallerServiceAccountDescribe' -Arguments @('iam', 'service-accounts', 'describe', $TaskCallerServiceAccount, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation
        $taskCallerServiceAccountIamPolicyResult = ConvertTo-SafeIamPolicyResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'taskCallerServiceAccountIamPolicy' -Arguments @('iam', 'service-accounts', 'get-iam-policy', $TaskCallerServiceAccount, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)
        Add-Result 'taskCallerServiceAccountDescribe' $taskCallerServiceAccountDescribeResult | Out-Null
        Add-Result 'taskCallerServiceAccountIamPolicy' $taskCallerServiceAccountIamPolicyResult | Out-Null
        $targetedResources['taskCallerServiceAccount'] = [ordered]@{ describe = $taskCallerServiceAccountDescribeResult; iamPolicy = $taskCallerServiceAccountIamPolicyResult }
    }
    else {
        $warnings.Add('target optional parameter not supplied: TaskCallerServiceAccount') | Out-Null
        Add-Result 'taskCallerServiceAccountDescribe' (New-NotRequestedResult -Id 'taskCallerServiceAccountDescribe') | Out-Null
        Add-Result 'taskCallerServiceAccountIamPolicy' (New-NotRequestedResult -Id 'taskCallerServiceAccountIamPolicy') | Out-Null
    }

    if ($TaskCreatorServiceAccount) {
        $taskCreatorServiceAccountDescribeResult = Invoke-ReadOnlyGcloudCommand -Id 'taskCreatorServiceAccountDescribe' -Arguments @('iam', 'service-accounts', 'describe', $TaskCreatorServiceAccount, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation
        $taskCreatorServiceAccountIamPolicyResult = ConvertTo-SafeIamPolicyResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'taskCreatorServiceAccountIamPolicy' -Arguments @('iam', 'service-accounts', 'get-iam-policy', $TaskCreatorServiceAccount, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)
        Add-Result 'taskCreatorServiceAccountDescribe' $taskCreatorServiceAccountDescribeResult | Out-Null
        Add-Result 'taskCreatorServiceAccountIamPolicy' $taskCreatorServiceAccountIamPolicyResult | Out-Null
        $targetedResources['taskCreatorServiceAccount'] = [ordered]@{ describe = $taskCreatorServiceAccountDescribeResult; iamPolicy = $taskCreatorServiceAccountIamPolicyResult }
    }
    else {
        $warnings.Add('target optional parameter not supplied: TaskCreatorServiceAccount') | Out-Null
        Add-Result 'taskCreatorServiceAccountDescribe' (New-NotRequestedResult -Id 'taskCreatorServiceAccountDescribe') | Out-Null
        Add-Result 'taskCreatorServiceAccountIamPolicy' (New-NotRequestedResult -Id 'taskCreatorServiceAccountIamPolicy') | Out-Null
    }

    if ($SupabaseSecretName) {
        $supabaseSecretDescribeResult = Invoke-ReadOnlyGcloudCommand -Id 'supabaseSecretDescribe' -Arguments @('secrets', 'describe', $SupabaseSecretName, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation
        $supabaseSecretVersionsListResult = Invoke-ReadOnlyGcloudCommand -Id 'supabaseSecretVersionsList' -Arguments @('secrets', 'versions', 'list', $SupabaseSecretName, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation
        $supabaseSecretIamPolicyResult = ConvertTo-SafeIamPolicyResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'supabaseSecretIamPolicy' -Arguments @('secrets', 'get-iam-policy', $SupabaseSecretName, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)
        Add-Result 'supabaseSecretDescribe' $supabaseSecretDescribeResult | Out-Null
        Add-Result 'supabaseSecretVersionsList' $supabaseSecretVersionsListResult | Out-Null
        Add-Result 'supabaseSecretIamPolicy' $supabaseSecretIamPolicyResult | Out-Null
        $targetedResources['supabaseSecret'] = [ordered]@{ describe = $supabaseSecretDescribeResult; versionsList = $supabaseSecretVersionsListResult; iamPolicy = $supabaseSecretIamPolicyResult }
    }
    else {
        $warnings.Add('target optional parameter not supplied: SupabaseSecretName') | Out-Null
        Add-Result 'supabaseSecretDescribe' (New-NotRequestedResult -Id 'supabaseSecretDescribe') | Out-Null
        Add-Result 'supabaseSecretVersionsList' (New-NotRequestedResult -Id 'supabaseSecretVersionsList') | Out-Null
        Add-Result 'supabaseSecretIamPolicy' (New-NotRequestedResult -Id 'supabaseSecretIamPolicy') | Out-Null
    }

    if ($GeminiSecretName) {
        $geminiSecretDescribeResult = Invoke-ReadOnlyGcloudCommand -Id 'geminiSecretDescribe' -Arguments @('secrets', 'describe', $GeminiSecretName, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation
        $geminiSecretVersionsListResult = Invoke-ReadOnlyGcloudCommand -Id 'geminiSecretVersionsList' -Arguments @('secrets', 'versions', 'list', $GeminiSecretName, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation
        $geminiSecretIamPolicyResult = ConvertTo-SafeIamPolicyResult -Result (Invoke-ReadOnlyGcloudCommand -Id 'geminiSecretIamPolicy' -Arguments @('secrets', 'get-iam-policy', $GeminiSecretName, '--project', $ProjectId, '--quiet', '--verbosity=error', '--format=json') -GcloudCommand $gcloudCommand -ProjectId $ProjectId -Region $Region -TasksLocation $TasksLocation)
        Add-Result 'geminiSecretDescribe' $geminiSecretDescribeResult | Out-Null
        Add-Result 'geminiSecretVersionsList' $geminiSecretVersionsListResult | Out-Null
        Add-Result 'geminiSecretIamPolicy' $geminiSecretIamPolicyResult | Out-Null
        $targetedResources['geminiSecret'] = [ordered]@{ describe = $geminiSecretDescribeResult; versionsList = $geminiSecretVersionsListResult; iamPolicy = $geminiSecretIamPolicyResult }
    }
    else {
        $warnings.Add('target optional parameter not supplied: GeminiSecretName') | Out-Null
        Add-Result 'geminiSecretDescribe' (New-NotRequestedResult -Id 'geminiSecretDescribe') | Out-Null
        Add-Result 'geminiSecretVersionsList' (New-NotRequestedResult -Id 'geminiSecretVersionsList') | Out-Null
        Add-Result 'geminiSecretIamPolicy' (New-NotRequestedResult -Id 'geminiSecretIamPolicy') | Out-Null
    }

    # Every variable the final report assembly reads must exist before the
    # evaluation try block below, even if evaluation throws on its very
    # first statement — otherwise Set-StrictMode would turn a reference to
    # an unset report-bound variable into a second, unhandled exception
    # during report assembly.
    $requiredApiEvaluation = [ordered]@{}

    # ---- Evaluation (wrapped: an unexpected error here becomes a blocker,
    # never an unhandled exception, and discovery has already fully
    # completed above regardless of what happens in this block) ----
    try {
        # Fail closed for every required generic discovery result.
        Add-GenericDiscoveryBlocker -Result $versionResult -Label 'gcloudVersion' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $authListResult -Label 'authList' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $configListResult -Label 'configList' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $projectDescribeResult -Label 'projectDescribe' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $projectIamPolicyResult -Label 'projectIamPolicy' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $enabledServicesResult -Label 'enabledServices' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $artifactRepositoriesResult -Label 'artifactRepositories' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $cloudRunServicesResult -Label 'cloudRunServices' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $serviceAccountsResult -Label 'serviceAccounts' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $secretsListResult -Label 'secrets' -Blockers $blockers
        Add-GenericDiscoveryBlocker -Result $taskQueuesResult -Label 'taskQueues' -Blockers $blockers

        # ---- Required API evaluation ----
        $enabledServiceNames = New-Object System.Collections.Generic.HashSet[string]
        if ($enabledServicesResult.status -eq 'success') {
            foreach ($entry in (ConvertTo-DataArray $enabledServicesResult.data)) {
                $name = Get-SafeProperty -Object $entry -PropertyPath @('config', 'name')
                if (-not $name) {
                    $name = Get-SafeProperty -Object $entry -PropertyPath @('name')
                }
                if ($name) {
                    $shortName = $name -replace '^.*/', ''
                    $enabledServiceNames.Add($shortName) | Out-Null
                }
            }
        }

        foreach ($api in $script:RequiredApis) {
            if ($enabledServicesResult.status -eq 'success') {
                $isEnabled = $enabledServiceNames.Contains($api)
                $requiredApiEvaluation[$api] = $isEnabled
                if (-not $isEnabled) {
                    $blockers.Add("required API disabled: $api") | Out-Null
                }
            }
            else {
                $requiredApiEvaluation[$api] = $null
                $blockers.Add("required API status unknown (enabled-services discovery unavailable): $api") | Out-Null
            }
        }

        # ---- Blocker/warning evaluation: local tooling & auth ----
        if (-not $gcloudCommand) {
            $blockers.Add('gcloud unavailable') | Out-Null
        }

        # Local CLOUDSDK_AUTH_* authentication-override check: any of these
        # environment variables (e.g. CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT,
        # CLOUDSDK_AUTH_ACCESS_TOKEN, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE,
        # CLOUDSDK_AUTH_DISABLE_CREDENTIALS) can silently change which identity
        # or credential every gcloud invocation in this script actually uses,
        # regardless of what gcloud auth list reports as the active account —
        # this is the environment-variable equivalent of the
        # --impersonate-service-account flag the command schema already
        # rejects. The whole environment is enumerated by exact name prefix
        # rather than a fixed list of known variable names, so this fails
        # closed against any current or future CLOUDSDK_AUTH_* variable.
        # The prefix match is deliberately case-INSENSITIVE (plain -match,
        # not -cmatch): environment-variable names are case-insensitive on
        # Windows — this repository's development environment — so gcloud
        # itself would still honor a mixed-case variable (e.g.
        # `CloudSdk_Auth_Impersonate_Service_Account`) even though a
        # case-sensitive scan would miss it entirely. A conservative false
        # positive on a platform where env-var names are case-sensitive is
        # accepted as strictly safer than a silent Windows bypass. Only
        # variable NAMES are ever placed in blocker text — never a value,
        # which could itself be a credential or token.
        $cloudSdkAuthOverrideNames = New-Object System.Collections.Generic.List[string]
        try {
            $allEnvironmentVariables = [System.Environment]::GetEnvironmentVariables()
            foreach ($environmentVariableName in $allEnvironmentVariables.Keys) {
                if ($environmentVariableName -match '^CLOUDSDK_AUTH_') {
                    $environmentVariableValue = $allEnvironmentVariables[$environmentVariableName]
                    if (-not [string]::IsNullOrEmpty($environmentVariableValue)) {
                        $cloudSdkAuthOverrideNames.Add($environmentVariableName) | Out-Null
                    }
                }
            }
        }
        catch {
            # Fail closed: if the environment itself cannot be safely
            # enumerated, an override can neither be confirmed absent nor
            # ruled out, so this is treated the same as a detected override.
            $cloudSdkAuthOverrideNames.Add('(environment enumeration failed)') | Out-Null
        }
        if ($cloudSdkAuthOverrideNames.Count -gt 0) {
            $blockers.Add('local CLOUDSDK_AUTH_* environment variable override detected: gcloud authentication behavior cannot be verified to match the audited active account') | Out-Null
        }

        if ($configListResult.status -eq 'success') {
            # $configListResult.data is already the normalized object built
            # by ConvertTo-SafeGcloudConfigListResult — never the raw
            # parsed configuration — so each of these three flags is a
            # reviewed boolean, not a raw string being inspected here for
            # the first time. Each persisted authentication-override
            # property is the configuration-file equivalent of its
            # CLOUDSDK_AUTH_* environment-variable counterpart above: any
            # one of them alone means the identity/credential actually used
            # by gcloud cannot be verified to match the audited active
            # account from gcloud auth list.
            $normalizedConfigList = $configListResult.data

            if ($normalizedConfigList.impersonateServiceAccountConfigured -eq $true) {
                $blockers.Add('local gcloud configuration sets auth/impersonate_service_account: gcloud authentication behavior cannot be verified to match the audited active account') | Out-Null
            }
            if ($normalizedConfigList.accessTokenFileConfigured -eq $true) {
                $blockers.Add('local gcloud configuration sets auth/access_token_file: gcloud authentication behavior cannot be verified to match the audited active account') | Out-Null
            }
            if ($normalizedConfigList.credentialFileOverrideConfigured -eq $true) {
                $blockers.Add('local gcloud configuration sets auth/credential_file_override: gcloud authentication behavior cannot be verified to match the audited active account') | Out-Null
            }
            if ($normalizedConfigList.disableCredentialsEnabled -eq $true) {
                # Generic, path-free: never includes the raw configured
                # value (there is none to expose — this is already a
                # reviewed boolean), but still never mentions any file or
                # token that might be associated with this setting.
                $blockers.Add('local gcloud configuration enables auth/disable_credentials: the audited active account cannot be trusted as the effective authentication identity') | Out-Null
            }
        }

        if ($authListResult.status -eq 'success') {
            $accounts = ConvertTo-DataArray $authListResult.data
            # ConvertTo-SafeAccountListResult already guarantees every entry
            # in a 'success' result has a valid non-empty string account and
            # a string status, but the account identifier is re-validated
            # here too: an ACTIVE entry can only count toward the
            # exactly-one-active-account requirement if it also carries a
            # valid projected account value.
            $activeAccounts = @($accounts | Where-Object {
                    $accountStatus = Get-SafeProperty -Object $_ -PropertyPath @('status')
                    $accountValue = Get-SafeProperty -Object $_ -PropertyPath @('account')
                    $accountStatus -ceq 'ACTIVE' -and $accountValue -is [string] -and -not [string]::IsNullOrWhiteSpace($accountValue)
                })
            if ($activeAccounts.Count -eq 0) {
                $blockers.Add('no active authenticated account') | Out-Null
            }
            elseif ($activeAccounts.Count -gt 1) {
                $blockers.Add('multiple active accounts') | Out-Null
            }
            elseif ($configListResult.status -eq 'success') {
                # Cross-check the local configuration's core/account
                # (already null-or-nonblank-string, guaranteed by the
                # normalizer) against the single audited active account — a
                # mismatch means the identity gcloud auth list reports as
                # active is not necessarily the identity gcloud itself will
                # actually use. Null/absent (never configured) is accepted
                # here without comparison — it is not itself a blocker.
                $normalizedConfigListForAccount = $configListResult.data
                if ($null -ne $normalizedConfigListForAccount.coreAccount) {
                    $activeAccountValue = Get-SafeProperty -Object $activeAccounts[0] -PropertyPath @('account')
                    if ($normalizedConfigListForAccount.coreAccount -cne $activeAccountValue) {
                        $blockers.Add('local gcloud configuration core/account does not match the audited active authenticated account') | Out-Null
                    }
                }
            }
        }
        else {
            $blockers.Add('local authentication state unavailable') | Out-Null
        }

        # ---- Project lifecycle ----
        if ($projectDescribeResult.status -eq 'success') {
            $lifecycleState = Get-SafeProperty -Object $projectDescribeResult.data -PropertyPath @('lifecycleState')
            if ($lifecycleState -cne 'ACTIVE') {
                $blockers.Add("project lifecycle state not ACTIVE: $lifecycleState") | Out-Null
            }
        }
        else {
            $blockers.Add('project unavailable') | Out-Null
        }

        # ---- Artifact Registry ----
        if ($artifactRepositoriesResult.status -eq 'success') {
            $repos = ConvertTo-DataArray $artifactRepositoriesResult.data
            $dockerRepos = @($repos | Where-Object { (Get-SafeProperty -Object $_ -PropertyPath @('format')) -ceq 'DOCKER' })
            if ($dockerRepos.Count -eq 0) {
                $blockers.Add('no Docker-format Artifact Registry repository in Region') | Out-Null
            }
            elseif ($dockerRepos.Count -gt 1) {
                $warnings.Add('multiple candidate Docker repositories') | Out-Null
            }
        }

        # ---- Cloud Tasks queues ----
        if ($taskQueuesResult.status -eq 'success') {
            # ConvertTo-DataArray's `return @()` branch, captured directly
            # into a scalar variable, unrolls to $null on the pipeline (a
            # PowerShell pipeline-unrolling quirk for empty arrays) — the
            # outer @(...) here forces a real (possibly empty) array so
            # .Count below is always safe under Set-StrictMode.
            $queues = @(ConvertTo-DataArray $taskQueuesResult.data)
            if ($queues.Count -gt 1) {
                $warnings.Add('multiple candidate queues') | Out-Null
            }
        }

        # ---- Targeted resource blockers/warnings (fail closed: every
        # required command for a supplied target must succeed) ----
        if ($WorkerServiceName) {
            $describeResult = $commandResults['workerServiceDescribe']
            $iamPolicyResult = $commandResults['workerServiceIamPolicy']

            Add-TargetVerificationBlockers -Label 'WorkerServiceName' -Blockers $blockers -Results ([ordered]@{
                    workerServiceDescribe  = $describeResult
                    workerServiceIamPolicy = $iamPolicyResult
                })

            if ($describeResult.status -eq 'not_found') {
                $warnings.Add('worker service does not yet exist') | Out-Null
            }
            elseif ($describeResult.status -eq 'success') {
                # By this point $describeResult.data is the reviewed,
                # normalized object from ConvertTo-SafeCloudRunDescribeResult
                # — it is only ever 'success' when invokerIamDisabled was a
                # real boolean and (when RuntimeServiceAccount was supplied)
                # runtimeServiceAccount was a non-empty string; a malformed
                # describe response already became 'failed' /
                # 'malformed_output' upstream and is caught by
                # Add-TargetVerificationBlockers above. Only the semantic
                # (value-matches-expectation) checks remain here.
                $normalizedWorkerService = $describeResult.data

                if ($RuntimeServiceAccount) {
                    $runtimeServiceAccountOnService = Get-SafeProperty -Object $normalizedWorkerService -PropertyPath @('runtimeServiceAccount')
                    if ($runtimeServiceAccountOnService -cne $RuntimeServiceAccount) {
                        $blockers.Add('supplied worker service using an unexpected runtime service account') | Out-Null
                    }
                }

                # Cloud Run's own IAM-based public-access control is
                # separate from this first-class field, which can disable
                # the Invoker IAM check entirely — a service must not pass
                # merely because allUsers/allAuthenticatedUsers are absent
                # from its IAM policy if this field has also turned the
                # check off.
                $invokerIamDisabled = Get-SafeProperty -Object $normalizedWorkerService -PropertyPath @('invokerIamDisabled')
                if ($invokerIamDisabled -eq $true) {
                    $blockers.Add('Cloud Run Invoker IAM check is disabled (invokerIamDisabled=true)') | Out-Null
                }
            }

            if ($iamPolicyResult.status -eq 'success') {
                $bindings = ConvertTo-DataArray (Get-SafeProperty -Object $iamPolicyResult.data -PropertyPath @('bindings'))
                # Conservative service-level public-principal check: ANY
                # binding under ANY role (not merely the two recognized
                # invocation roles) granted to allUsers or
                # allAuthenticatedUsers is a blocker — this closes gaps like
                # roles/run.admin or an unknown/custom role that could still
                # make the service publicly reachable.
                $publicBinding = $bindings | Where-Object {
                    $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                    @($members) | Where-Object { $_ -ceq 'allUsers' -or $_ -ceq 'allAuthenticatedUsers' }
                }
                if (@($publicBinding).Count -gt 0) {
                    $blockers.Add('worker-service IAM policy grants a role to allUsers or allAuthenticatedUsers') | Out-Null
                }

                if ($TaskCallerServiceAccount -and $projectIamPolicyResult.status -eq 'success') {
                    # The task-caller identity's explicit invocation binding
                    # is recognized under either roles/run.invoker or
                    # roles/run.servicesInvoker, and is accepted at EITHER
                    # the worker-service IAM scope OR the project IAM scope
                    # — folder/organization inheritance is still not proof
                    # (this preflight cannot retrieve it; see the separate
                    # ancestor-IAM warning below). Absent both, this is a
                    # blocker, not a warning: an unauthorized task caller
                    # cannot invoke the worker service at all.
                    $callerMember = "serviceAccount:$TaskCallerServiceAccount"
                    $callerServiceMatchingBindings = $bindings | Where-Object {
                        $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                        $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                        ($script:CloudRunInvocationRoles -ccontains $role) -and (@($members) | Where-Object { $_ -ceq $callerMember })
                    }
                    $callerServiceBinding = $callerServiceMatchingBindings | Where-Object { Test-IsUnconditionalBinding -Binding $_ }

                    $projectBindingsForCaller = ConvertTo-DataArray (Get-SafeProperty -Object $projectIamPolicyResult.data -PropertyPath @('bindings'))
                    $callerProjectMatchingBindings = $projectBindingsForCaller | Where-Object {
                        $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                        $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                        ($script:CloudRunInvocationRoles -ccontains $role) -and (@($members) | Where-Object { $_ -ceq $callerMember })
                    }
                    $callerProjectBinding = $callerProjectMatchingBindings | Where-Object { Test-IsUnconditionalBinding -Binding $_ }

                    if (@($callerServiceBinding).Count -eq 0 -and @($callerProjectBinding).Count -eq 0) {
                        $blockers.Add('task-caller service account lacks an explicit Cloud Run invocation binding') | Out-Null
                    }

                    # A Where-Object pipeline assignment is not guaranteed to
                    # be an array: zero matches assigns $null, exactly one
                    # match assigns the single scalar object itself (not a
                    # one-element array), and only two-or-more matches
                    # assign a real array — so `+` can never be applied to
                    # $callerServiceMatchingBindings/$callerProjectMatchingBindings
                    # directly (a scalar + a scalar would not concatenate as
                    # array elements the way this check requires). Wrapping
                    # each operand with @(...) first normalizes zero, one,
                    # or multiple matches to an array uniformly before they
                    # are combined and filtered.
                    $combinedCallerMatchingBindings = @($callerServiceMatchingBindings) + @($callerProjectMatchingBindings)
                    $conditionalCallerMatchingBindings = @(
                        $combinedCallerMatchingBindings | Where-Object { -not (Test-IsUnconditionalBinding -Binding $_) }
                    )
                    if ($conditionalCallerMatchingBindings.Count -gt 0) {
                        $warnings.Add('conditional IAM binding present for the task-caller Cloud Run invocation role; requires separate human review') | Out-Null
                    }
                }
            }
        }

        if ($ArtifactRepository) {
            $describeResult = $commandResults['artifactRepositoryDescribe']

            Add-TargetVerificationBlockers -Label 'ArtifactRepository' -Blockers $blockers -Results ([ordered]@{
                    artifactRepositoryDescribe  = $describeResult
                    artifactRepositoryIamPolicy = $commandResults['artifactRepositoryIamPolicy']
                })

            if ($describeResult.status -eq 'success') {
                $repositoryFormat = Get-SafeProperty -Object $describeResult.data -PropertyPath @('format')
                if ([string]::IsNullOrEmpty($repositoryFormat)) {
                    $blockers.Add('supplied artifact repository missing format metadata') | Out-Null
                }
                elseif ($repositoryFormat -cne 'DOCKER') {
                    $blockers.Add("supplied artifact repository is not Docker-format: $repositoryFormat") | Out-Null
                }
            }
        }

        if ($QueueName) {
            $describeResult = $commandResults['queueDescribe']

            Add-TargetVerificationBlockers -Label 'QueueName' -Blockers $blockers -Results ([ordered]@{
                    queueDescribe  = $describeResult
                    queueIamPolicy = $commandResults['queueIamPolicy']
                })

            if ($describeResult.status -eq 'success') {
                # Production dispatch must remain PAUSED before a
                # controlled rollout — RUNNING means the queue is actively
                # dispatching, which is unsafe during preflight, and the
                # queue is only ever resumed in a separately authorized
                # rollout phase (never by this read-only tool).
                $queueState = Get-SafeProperty -Object $describeResult.data -PropertyPath @('state')
                if ($queueState -isnot [string] -or [string]::IsNullOrWhiteSpace($queueState)) {
                    # Missing, null, blank, or non-string state is malformed
                    # metadata, not merely an empty value — call it out
                    # distinctly so a reviewer knows the response itself was
                    # incomplete rather than the queue being in some other
                    # known state.
                    $blockers.Add('supplied queue missing state metadata') | Out-Null
                }
                elseif ($queueState -ceq 'RUNNING') {
                    $blockers.Add('supplied queue is RUNNING: production dispatch is not paused') | Out-Null
                }
                elseif ($queueState -cne 'PAUSED') {
                    # DISABLED or any other recognized/unexpected state is
                    # not the required pre-rollout PAUSED state.
                    $blockers.Add("supplied queue is not in the required PAUSED pre-rollout state: $queueState") | Out-Null
                }
            }
        }

        if ($RuntimeServiceAccount) {
            $describeResult = $commandResults['runtimeServiceAccountDescribe']

            Add-TargetVerificationBlockers -Label 'RuntimeServiceAccount' -Blockers $blockers -Results ([ordered]@{
                    runtimeServiceAccountDescribe  = $describeResult
                    runtimeServiceAccountIamPolicy = $commandResults['runtimeServiceAccountIamPolicy']
                })

            if ($describeResult.status -eq 'success') {
                $isDisabled = Get-SafeProperty -Object $describeResult.data -PropertyPath @('disabled')
                if ($null -eq $isDisabled -or $isDisabled -isnot [bool]) {
                    # A successful describe response is not enough on its
                    # own: a missing, null, or non-boolean disabled field is
                    # malformed metadata and must block rather than be
                    # silently treated as "not disabled".
                    $blockers.Add('malformed service-account metadata: missing or non-boolean disabled field for RuntimeServiceAccount') | Out-Null
                }
                elseif ($isDisabled -eq $true) {
                    $blockers.Add('supplied service account disabled: RuntimeServiceAccount') | Out-Null
                }
            }
        }

        if ($TaskCallerServiceAccount) {
            $describeResult = $commandResults['taskCallerServiceAccountDescribe']

            Add-TargetVerificationBlockers -Label 'TaskCallerServiceAccount' -Blockers $blockers -Results ([ordered]@{
                    taskCallerServiceAccountDescribe  = $describeResult
                    taskCallerServiceAccountIamPolicy = $commandResults['taskCallerServiceAccountIamPolicy']
                })

            if ($describeResult.status -eq 'success') {
                $isDisabled = Get-SafeProperty -Object $describeResult.data -PropertyPath @('disabled')
                if ($null -eq $isDisabled -or $isDisabled -isnot [bool]) {
                    $blockers.Add('malformed service-account metadata: missing or non-boolean disabled field for TaskCallerServiceAccount') | Out-Null
                }
                elseif ($isDisabled -eq $true) {
                    $blockers.Add('supplied service account disabled: TaskCallerServiceAccount') | Out-Null
                }
            }
        }

        if ($TaskCreatorServiceAccount) {
            $describeResult = $commandResults['taskCreatorServiceAccountDescribe']

            Add-TargetVerificationBlockers -Label 'TaskCreatorServiceAccount' -Blockers $blockers -Results ([ordered]@{
                    taskCreatorServiceAccountDescribe  = $describeResult
                    taskCreatorServiceAccountIamPolicy = $commandResults['taskCreatorServiceAccountIamPolicy']
                })

            if ($describeResult.status -eq 'success') {
                $isDisabled = Get-SafeProperty -Object $describeResult.data -PropertyPath @('disabled')
                if ($null -eq $isDisabled -or $isDisabled -isnot [bool]) {
                    $blockers.Add('malformed service-account metadata: missing or non-boolean disabled field for TaskCreatorServiceAccount') | Out-Null
                }
                elseif ($isDisabled -eq $true) {
                    $blockers.Add('supplied service account disabled: TaskCreatorServiceAccount') | Out-Null
                }
            }
        }

        if ($RuntimeServiceAccount -and $TaskCallerServiceAccount -and ($RuntimeServiceAccount -ceq $TaskCallerServiceAccount)) {
            $blockers.Add('runtime and task-caller service accounts being the same identity') | Out-Null
        }

        if ($TaskCreatorServiceAccount -and $RuntimeServiceAccount -and ($TaskCreatorServiceAccount -ceq $RuntimeServiceAccount)) {
            $blockers.Add('task-creator and runtime service accounts being the same identity') | Out-Null
        }

        if ($TaskCreatorServiceAccount -and $TaskCallerServiceAccount -and ($TaskCreatorServiceAccount -ceq $TaskCallerServiceAccount)) {
            $blockers.Add('task-creator and task-caller service accounts being the same identity') | Out-Null
        }

        # ---- Section 1: Cloud Tasks OIDC IAM prerequisites (only evaluated
        # when TaskCallerServiceAccount is supplied, since these checks
        # verify the delegation chain that lets a task creator enqueue an
        # OIDC-authenticated task the task-caller identity later executes) ----
        if ($TaskCallerServiceAccount) {
            if (-not $TaskCreatorServiceAccount) {
                $blockers.Add('task creator lacks explicit iam.serviceAccounts.actAs authorization on the task-caller service account') | Out-Null
            }
            else {
                $taskCallerServiceAccountIamPolicyForActAs = $commandResults['taskCallerServiceAccountIamPolicy']
                if ($taskCallerServiceAccountIamPolicyForActAs.status -eq 'success') {
                    # Only an explicit roles/iam.serviceAccountUser binding
                    # for the task creator on the task-caller service
                    # account proves actAs authorization — Owner, Editor,
                    # and any unknown/custom role (which may or may not
                    # contain the actAs permission) are never accepted as
                    # proof; a custom role containing actAs requires
                    # separate human review.
                    $taskCallerBindingsForActAs = ConvertTo-DataArray (Get-SafeProperty -Object $taskCallerServiceAccountIamPolicyForActAs.data -PropertyPath @('bindings'))
                    $actAsMember = "serviceAccount:$TaskCreatorServiceAccount"
                    $actAsMatchingBindings = $taskCallerBindingsForActAs | Where-Object {
                        $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                        $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                        ($role -ceq 'roles/iam.serviceAccountUser') -and (@($members) | Where-Object { $_ -ceq $actAsMember })
                    }
                    # Only an unconditional matching binding counts as proof
                    # — IAM conditions are never evaluated by this
                    # preflight, so a conditional binding can never satisfy
                    # this requirement automatically.
                    $actAsBinding = $actAsMatchingBindings | Where-Object { Test-IsUnconditionalBinding -Binding $_ }
                    if (@($actAsBinding).Count -eq 0) {
                        $blockers.Add('task creator lacks explicit iam.serviceAccounts.actAs authorization on the task-caller service account') | Out-Null
                    }
                    if (@($actAsMatchingBindings | Where-Object { -not (Test-IsUnconditionalBinding -Binding $_) }).Count -gt 0) {
                        $warnings.Add('conditional IAM binding present for task-creator actAs authorization on the task-caller service account; requires separate human review') | Out-Null
                    }
                }
            }

            if ($projectDescribeResult.status -eq 'success') {
                $projectNumberRaw = Get-SafeProperty -Object $projectDescribeResult.data -PropertyPath @('projectNumber')
                # Only a nonblank string of plain positive digits, or a
                # positive integral numeric scalar, is accepted — "0",
                # negative values, decimals, exponent notation, and signed
                # strings are all rejected as malformed rather than
                # silently coerced into a Cloud Tasks service-agent
                # principal.
                $projectNumberIsValidString = ($projectNumberRaw -is [string]) -and ($projectNumberRaw -cmatch '^[1-9][0-9]*$')
                $projectNumberIsValidNumeric = (($projectNumberRaw -is [int]) -or ($projectNumberRaw -is [long]) -or ($projectNumberRaw -is [uint32]) -or ($projectNumberRaw -is [uint64])) -and ($projectNumberRaw -gt 0)

                if (-not $projectNumberIsValidString -and -not $projectNumberIsValidNumeric) {
                    $blockers.Add('project number is missing or malformed: cannot construct the Cloud Tasks service-agent identity') | Out-Null
                }
                else {
                    if ($projectNumberIsValidString) {
                        $projectNumberDigits = $projectNumberRaw
                    }
                    else {
                        $projectNumberDigits = [string]$projectNumberRaw
                    }

                    # The converted value itself is revalidated before it is
                    # ever interpolated into an IAM principal — this is the
                    # last line of defense against a numeric-to-string
                    # conversion producing anything other than plain
                    # positive digits.
                    if ($projectNumberDigits -cnotmatch '^[1-9][0-9]*$') {
                        $blockers.Add('project number is missing or malformed: cannot construct the Cloud Tasks service-agent identity') | Out-Null
                    }
                    else {
                        # The Cloud Tasks service agent identity is
                        # constructed only from the already-retrieved,
                        # revalidated project number — never from a
                        # caller-supplied value — and only this exact
                        # member is checked for the required project-level
                        # roles/cloudtasks.serviceAgent binding.
                        $cloudTasksServiceAgentMember = "serviceAccount:service-$projectNumberDigits@gcp-sa-cloudtasks.iam.gserviceaccount.com"

                        if ($projectIamPolicyResult.status -eq 'success') {
                            $projectBindingsForServiceAgent = ConvertTo-DataArray (Get-SafeProperty -Object $projectIamPolicyResult.data -PropertyPath @('bindings'))
                            $serviceAgentMatchingBindings = $projectBindingsForServiceAgent | Where-Object {
                                $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                                $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                                ($role -ceq 'roles/cloudtasks.serviceAgent') -and (@($members) | Where-Object { $_ -ceq $cloudTasksServiceAgentMember })
                            }
                            $serviceAgentBinding = $serviceAgentMatchingBindings | Where-Object { Test-IsUnconditionalBinding -Binding $_ }
                            if (@($serviceAgentBinding).Count -eq 0) {
                                $blockers.Add('Cloud Tasks service agent lacks the required roles/cloudtasks.serviceAgent project-level binding') | Out-Null
                            }
                            if (@($serviceAgentMatchingBindings | Where-Object { -not (Test-IsUnconditionalBinding -Binding $_) }).Count -gt 0) {
                                $warnings.Add('conditional IAM binding present for the Cloud Tasks service-agent project-level binding; requires separate human review') | Out-Null
                            }
                        }

                        # Separate from every other check in this section:
                        # the Cloud Tasks primary service agent must itself
                        # hold an explicit, unconditional
                        # roles/iam.serviceAccountUser binding on the
                        # task-caller service account — this is the actAs
                        # authorization the service agent needs to mint an
                        # OIDC token as the task-caller identity when
                        # dispatching a task. Reuses the already-validated
                        # $cloudTasksServiceAgentMember and the
                        # already-retrieved taskCallerServiceAccountIamPolicy
                        # result; no new gcloud command is issued.
                        $taskCallerServiceAccountIamPolicyForServiceAgentActAs = $commandResults['taskCallerServiceAccountIamPolicy']
                        if ($taskCallerServiceAccountIamPolicyForServiceAgentActAs.status -eq 'success') {
                            $taskCallerBindingsForServiceAgentActAs = ConvertTo-DataArray (Get-SafeProperty -Object $taskCallerServiceAccountIamPolicyForServiceAgentActAs.data -PropertyPath @('bindings'))
                            $serviceAgentActAsMatchingBindings = $taskCallerBindingsForServiceAgentActAs | Where-Object {
                                $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                                $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                                ($role -ceq 'roles/iam.serviceAccountUser') -and (@($members) | Where-Object { $_ -ceq $cloudTasksServiceAgentMember })
                            }
                            $serviceAgentActAsBinding = $serviceAgentActAsMatchingBindings | Where-Object { Test-IsUnconditionalBinding -Binding $_ }
                            if (@($serviceAgentActAsBinding).Count -eq 0) {
                                $blockers.Add('Cloud Tasks service agent lacks explicit actAs authorization on the task-caller service account') | Out-Null
                            }
                            if (@($serviceAgentActAsMatchingBindings | Where-Object { -not (Test-IsUnconditionalBinding -Binding $_) }).Count -gt 0) {
                                $warnings.Add('conditional IAM binding present for the Cloud Tasks service-agent actAs authorization on the task-caller service account; requires separate human review') | Out-Null
                            }
                        }
                    }
                }
            }
        }

        # ---- Task-creator Cloud Tasks Enqueuer authorization: when both a
        # queue and a task creator are supplied and both the queue IAM
        # policy and the project IAM policy were successfully retrieved,
        # the task creator must hold an explicit, unconditional
        # roles/cloudtasks.enqueuer binding at either the queue IAM scope or
        # the project IAM scope. Owner, Editor, Cloud Tasks Admin, Cloud
        # Tasks Editor, and any unknown/custom role are never accepted as
        # proof — those may happen to contain cloudtasks.tasks.create but do
        # not demonstrate the narrow, least-privilege deployment
        # configuration this check requires. ----
        if ($QueueName -and $TaskCreatorServiceAccount) {
            $queueIamPolicyResultForEnqueuer = $commandResults['queueIamPolicy']
            if ($queueIamPolicyResultForEnqueuer.status -eq 'success' -and $projectIamPolicyResult.status -eq 'success') {
                $enqueuerMember = "serviceAccount:$TaskCreatorServiceAccount"

                $queueBindingsForEnqueuer = ConvertTo-DataArray (Get-SafeProperty -Object $queueIamPolicyResultForEnqueuer.data -PropertyPath @('bindings'))
                $enqueuerQueueMatchingBindings = $queueBindingsForEnqueuer | Where-Object {
                    $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                    $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                    ($role -ceq 'roles/cloudtasks.enqueuer') -and (@($members) | Where-Object { $_ -ceq $enqueuerMember })
                }
                $enqueuerQueueBinding = $enqueuerQueueMatchingBindings | Where-Object { Test-IsUnconditionalBinding -Binding $_ }

                $projectBindingsForEnqueuer = ConvertTo-DataArray (Get-SafeProperty -Object $projectIamPolicyResult.data -PropertyPath @('bindings'))
                $enqueuerProjectMatchingBindings = $projectBindingsForEnqueuer | Where-Object {
                    $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                    $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                    ($role -ceq 'roles/cloudtasks.enqueuer') -and (@($members) | Where-Object { $_ -ceq $enqueuerMember })
                }
                $enqueuerProjectBinding = $enqueuerProjectMatchingBindings | Where-Object { Test-IsUnconditionalBinding -Binding $_ }

                if (@($enqueuerQueueBinding).Count -eq 0 -and @($enqueuerProjectBinding).Count -eq 0) {
                    $blockers.Add('task creator lacks an explicit Cloud Tasks Enqueuer binding') | Out-Null
                }

                # Same scalar-pipeline-result hazard as the task-caller
                # invocation check above: a Where-Object assignment yields
                # $null for zero matches, the bare scalar object itself for
                # exactly one match, or a real array only for two-or-more
                # matches — so `+` can never be applied to
                # $enqueuerQueueMatchingBindings/$enqueuerProjectMatchingBindings
                # directly. Wrapping each operand with @(...) first
                # normalizes zero, one, or multiple matches to an array
                # uniformly before they are combined and filtered.
                $combinedEnqueuerMatchingBindings = @($enqueuerQueueMatchingBindings) + @($enqueuerProjectMatchingBindings)
                $conditionalEnqueuerMatchingBindings = @(
                    $combinedEnqueuerMatchingBindings | Where-Object { -not (Test-IsUnconditionalBinding -Binding $_) }
                )
                if ($conditionalEnqueuerMatchingBindings.Count -gt 0) {
                    $warnings.Add('conditional IAM binding present for the task-creator Cloud Tasks Enqueuer access; requires separate human review') | Out-Null
                }
            }
        }

        if ($projectIamPolicyResult.status -eq 'success') {
            $projectBindings = ConvertTo-DataArray (Get-SafeProperty -Object $projectIamPolicyResult.data -PropertyPath @('bindings'))
            foreach ($candidateAccount in @($RuntimeServiceAccount, $TaskCallerServiceAccount, $TaskCreatorServiceAccount)) {
                if (-not $candidateAccount) { continue }
                $member = "serviceAccount:$candidateAccount"
                $ownerOrEditorBinding = $projectBindings | Where-Object {
                    $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                    $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                    ($role -ceq 'roles/owner' -or $role -ceq 'roles/editor') -and (@($members) | Where-Object { $_ -ceq $member })
                }
                if (@($ownerOrEditorBinding).Count -gt 0) {
                    $blockers.Add("project-level Owner or Editor granted to supplied service account: $candidateAccount") | Out-Null
                }
            }

            # Project-level IAM bindings are inherited by every Cloud Run
            # service in the project, so a project-level allUsers/
            # allAuthenticatedUsers binding is checked independently of the
            # service-level IAM check above. Rather than enumerating only
            # invocation-capable built-in roles (at minimum
            # roles/run.invoker, roles/run.servicesInvoker, roles/run.admin,
            # roles/owner, roles/editor), this applies the more conservative
            # rule explicitly permitted for this private-worker project:
            # any project-level role at all granted to either public
            # principal is a blocker, regardless of which role it is.
            $publicProjectBinding = $projectBindings | Where-Object {
                $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                @($members) | Where-Object { $_ -ceq 'allUsers' -or $_ -ceq 'allAuthenticatedUsers' }
            }
            if (@($publicProjectBinding).Count -gt 0) {
                $blockers.Add('project-level IAM policy grants a role to allUsers or allAuthenticatedUsers') | Out-Null
            }
        }

        # This preflight is scoped to the explicit project only. Folder- and
        # organization-level IAM policies can also grant access that is
        # inherited down into this project's Cloud Run services, and this
        # tool has no way to retrieve or evaluate them.
        $warnings.Add('folder- and organization-level inherited IAM policies are not retrieved by this project-scoped preflight and require separate human review') | Out-Null

        foreach ($secretInfo in @(
                @{ Name = $SupabaseSecretName; DescribeKey = 'supabaseSecretDescribe'; VersionsKey = 'supabaseSecretVersionsList'; IamKey = 'supabaseSecretIamPolicy'; Label = 'SupabaseSecretName' },
                @{ Name = $GeminiSecretName; DescribeKey = 'geminiSecretDescribe'; VersionsKey = 'geminiSecretVersionsList'; IamKey = 'geminiSecretIamPolicy'; Label = 'GeminiSecretName' }
            )) {
            if (-not $secretInfo.Name) { continue }
            $describeResult = $commandResults[$secretInfo.DescribeKey]
            $versionsResult = $commandResults[$secretInfo.VersionsKey]
            $iamPolicyResult = $commandResults[$secretInfo.IamKey]

            $targetResults = [ordered]@{}
            $targetResults[$secretInfo.DescribeKey] = $describeResult
            $targetResults[$secretInfo.VersionsKey] = $versionsResult
            $targetResults[$secretInfo.IamKey] = $iamPolicyResult
            Add-TargetVerificationBlockers -Label $secretInfo.Label -Blockers $blockers -Results $targetResults

            if ($versionsResult.status -eq 'success') {
                $versions = ConvertTo-DataArray $versionsResult.data

                # Fail closed on ANY malformed entry: a successful
                # version-list response containing even one structurally
                # malformed entry (null, a scalar, a non-string state/name,
                # or a name that isn't a plain positive-integer
                # /versions/<N>) is itself a blocker — even when another
                # entry in the same list is a valid, enabled numbered
                # version. This is intentionally separate from, and in
                # addition to, the no-enabled-numbered-version blocker
                # below; it is never silently filtered out and forgotten.
                $malformedVersionEntries = @($versions | Where-Object { -not (Test-IsValidSecretVersionEntry -VersionEntry $_) })
                if (@($malformedVersionEntries).Count -gt 0) {
                    $blockers.Add("malformed secret-version metadata: $($secretInfo.Label)") | Out-Null
                }

                # Separately, among only the structurally valid entries,
                # require at least one whose state is exactly the string
                # 'ENABLED' — this rejects 'latest', any other alias,
                # version 0, negative/signed values, and a missing or
                # non-string name, since those already failed the
                # structural-validity check above and can never reach here.
                $enabledVersions = @($versions | Where-Object {
                        (Test-IsValidSecretVersionEntry -VersionEntry $_) -and ((Get-SafeProperty -Object $_ -PropertyPath @('state')) -ceq 'ENABLED')
                    })
                if ($enabledVersions.Count -eq 0) {
                    $blockers.Add("supplied secret with no enabled numbered version: $($secretInfo.Label)") | Out-Null
                    $warnings.Add("target secret exists but has no enabled numbered version: $($secretInfo.Label)") | Out-Null
                }
            }

            # Narrow secret access: the runtime service account must hold an
            # explicit secret-level roles/secretmanager.secretAccessor
            # binding on this specific secret — project-wide access is never
            # accepted as sufficient here (that is instead a separate,
            # overbroad-access blocker below).
            if ($RuntimeServiceAccount -and $iamPolicyResult.status -eq 'success') {
                $secretBindings = ConvertTo-DataArray (Get-SafeProperty -Object $iamPolicyResult.data -PropertyPath @('bindings'))
                $secretAccessorMember = "serviceAccount:$RuntimeServiceAccount"
                $secretAccessorMatchingBindings = $secretBindings | Where-Object {
                    $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                    $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                    ($role -ceq 'roles/secretmanager.secretAccessor') -and (@($members) | Where-Object { $_ -ceq $secretAccessorMember })
                }
                # Only an unconditional secret-level binding counts as proof
                # of required runtime access — a conditional binding is
                # never accepted automatically.
                $secretAccessorBinding = $secretAccessorMatchingBindings | Where-Object { Test-IsUnconditionalBinding -Binding $_ }
                if (@($secretAccessorBinding).Count -eq 0) {
                    $blockers.Add("runtime service account missing secret-level roles/secretmanager.secretAccessor binding: $($secretInfo.Label)") | Out-Null
                }
                if (@($secretAccessorMatchingBindings | Where-Object { -not (Test-IsUnconditionalBinding -Binding $_) }).Count -gt 0) {
                    $warnings.Add("conditional IAM binding present for the runtime service account's secret-level access; requires separate human review: $($secretInfo.Label)") | Out-Null
                }
            }
        }

        # Narrow secret access, project scope: the runtime service account
        # must not hold roles/secretmanager.secretAccessor at the project
        # level — that would grant it every current and future secret in
        # the project, broader than the intended two-secret model, even if
        # every per-secret binding above is also individually correct.
        if ($RuntimeServiceAccount -and ($SupabaseSecretName -or $GeminiSecretName) -and $projectIamPolicyResult.status -eq 'success') {
            $projectBindingsForSecretAccessor = ConvertTo-DataArray (Get-SafeProperty -Object $projectIamPolicyResult.data -PropertyPath @('bindings'))
            $runtimeMemberForSecretAccessor = "serviceAccount:$RuntimeServiceAccount"
            $projectSecretAccessorBinding = $projectBindingsForSecretAccessor | Where-Object {
                $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                ($role -ceq 'roles/secretmanager.secretAccessor') -and (@($members) | Where-Object { $_ -ceq $runtimeMemberForSecretAccessor })
            }
            if (@($projectSecretAccessorBinding).Count -gt 0) {
                $blockers.Add('runtime service account holds project-level roles/secretmanager.secretAccessor access, broader than the intended two-secret model') | Out-Null
            }
        }

        # Narrow secret access, project scope (admin): roles/secretmanager.admin
        # grants full management of every secret in the project (create,
        # delete, update IAM policy, and access every version) — strictly
        # broader than even the project-wide secretAccessor case above. This
        # is blocked unconditionally, like the other overbroad/Owner/Editor
        # checks: an IAM condition on this binding is never accepted as a
        # narrowing safeguard.
        if ($RuntimeServiceAccount -and $projectIamPolicyResult.status -eq 'success') {
            $projectBindingsForSecretAdmin = ConvertTo-DataArray (Get-SafeProperty -Object $projectIamPolicyResult.data -PropertyPath @('bindings'))
            $runtimeMemberForSecretAdmin = "serviceAccount:$RuntimeServiceAccount"
            $projectSecretAdminBinding = $projectBindingsForSecretAdmin | Where-Object {
                $role = Get-SafeProperty -Object $_ -PropertyPath @('role')
                $members = ConvertTo-DataArray (Get-SafeProperty -Object $_ -PropertyPath @('members'))
                ($role -ceq 'roles/secretmanager.admin') -and (@($members) | Where-Object { $_ -ceq $runtimeMemberForSecretAdmin })
            }
            if (@($projectSecretAdminBinding).Count -gt 0) {
                $blockers.Add('runtime service account holds project-level roles/secretmanager.admin access, broader than the intended two-secret model') | Out-Null
            }
        }
    }
    catch {
        # Contain any unexpected evaluation error: no exception object, no
        # stack trace, just a sanitized message — and discovery has already
        # completed, so the report write attempt below still proceeds.
        $blockers.Add("unexpected evaluation error: $(Get-SafeErrorText -Text $_.Exception.Message)") | Out-Null
    }

    $warnings.Add('report contains cloud resource metadata and must not be committed') | Out-Null

    # ---- Assemble, serialize, and write the report as one protected
    # boundary: assembly, ConvertTo-Json, opening OutputPath, writing,
    # flushing, and disposing are all inside this single try. Any failure
    # anywhere in that sequence is exit code 4, with no exception object,
    # no stack trace, and (only if this process itself created the output
    # file via CreateNew) removal of that partial file — never a
    # pre-existing one, and never via a Force/Overwrite parameter. ----
    $createdOutputFile = $false
    try {
        $report = [ordered]@{
            schemaVersion            = $script:SchemaVersion
            generatedAtUtc           = (Get-Date).ToUniversalTime().ToString('o')
            mode                     = 'read-only'
            projectId                = $ProjectId
            region                   = $Region
            tasksLocation            = $TasksLocation
            localTooling             = $versionResult
            activeAccounts           = $authListResult
            project                  = $projectDescribeResult
            requiredApis             = $requiredApiEvaluation
            artifactRepositories     = $artifactRepositoriesResult
            cloudRunServices         = $cloudRunServicesResult
            serviceAccounts          = $serviceAccountsResult
            secrets                  = $secretsListResult
            taskQueues               = $taskQueuesResult
            projectIamPolicy         = $projectIamPolicyResult
            targetedResources        = $targetedResources
            blockers                 = @($blockers)
            warnings                 = @($warnings)
            commandResults           = $commandResults
            humanReviewRequired      = $true
            deploymentReadinessClaim = 'none: this report is discovery data only and does not certify deployment readiness'
        }

        $json = $report | ConvertTo-Json -Depth 25

        $fileStream = [System.IO.File]::Open($resolvedOutputPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
        $createdOutputFile = $true
        try {
            $writer = New-Object System.IO.StreamWriter($fileStream, [System.Text.Encoding]::UTF8)
            try {
                $writer.Write($json)
                $writer.Flush()
            }
            finally {
                $writer.Dispose()
            }
        }
        finally {
            $fileStream.Dispose()
        }
    }
    catch {
        # Never use Write-Error here, for the same reason as the local
        # validation path: it would become terminating under
        # $ErrorActionPreference = 'Stop' and escape before `return 4` runs.
        [Console]::Error.WriteLine("Preflight report could not be safely written: $(Get-SafeErrorText -Text $_.Exception.Message)")

        if ($createdOutputFile) {
            try {
                if (Test-Path -LiteralPath $resolvedOutputPath -PathType Leaf) {
                    Remove-Item -LiteralPath $resolvedOutputPath -Force -ErrorAction Stop
                }
            }
            catch {
                # Cleanup failure must not change the required exit code — it
                # still returns 4 unconditionally below. Only one additional,
                # generic sanitized diagnostic is emitted here: no
                # OutputPath, no exception object, no stack trace.
                [Console]::Error.WriteLine('Preflight partial report cleanup failed.')
            }
        }

        return 4
    }

    if ($blockers.Count -gt 0) {
        return 2
    }
    return 0
}

$script:IsDotSourced = $MyInvocation.InvocationName -eq '.'

if (-not $script:IsDotSourced) {
    # Repository-root resolution and invocation setup happen before any
    # cloud discovery, so a failure here (e.g. an unexpected directory
    # layout) must be contained the same way local validation failures are:
    # a sanitized, non-terminating diagnostic and exit code 3 — never an
    # unhandled exception producing an unintended exit code.
    try {
        $repositoryRoot = Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath '..\..')
    }
    catch {
        [Console]::Error.WriteLine("Preflight setup failed before any cloud discovery: $(Get-SafeErrorText -Text $_.Exception.Message)")
        exit 3
    }

    # The main call itself is wrapped in its own try/catch, separate from
    # repository-root setup above: an unexpected exception escaping
    # Invoke-PrivateWorkerPreflightMain must never fall through to
    # PowerShell's default process exit code — it becomes a sanitized,
    # non-terminating diagnostic (no stack trace, no exception object) and
    # exit code 4, the same code used when the report itself cannot be
    # safely written.
    $mainExitCode = $null
    try {
        $mainExitCode = Invoke-PrivateWorkerPreflightMain `
            -ProjectId $ProjectId `
            -Region $Region `
            -TasksLocation $TasksLocation `
            -OutputPath $OutputPath `
            -WorkerServiceName $WorkerServiceName `
            -ArtifactRepository $ArtifactRepository `
            -QueueName $QueueName `
            -RuntimeServiceAccount $RuntimeServiceAccount `
            -TaskCallerServiceAccount $TaskCallerServiceAccount `
            -TaskCreatorServiceAccount $TaskCreatorServiceAccount `
            -SupabaseSecretName $SupabaseSecretName `
            -GeminiSecretName $GeminiSecretName `
            -RepositoryRoot $repositoryRoot
    }
    catch {
        [Console]::Error.WriteLine("Preflight failed unexpectedly: $(Get-SafeErrorText -Text $_.Exception.Message)")
        exit 4
    }

    # Only 0, 2, 3, or 4 are approved exit codes. A returned value outside
    # that set is itself treated as a failure to safely complete — exit 4 —
    # rather than being forwarded as-is.
    $approvedExitCodes = @(0, 2, 3, 4)
    if ($approvedExitCodes -notcontains $mainExitCode) {
        exit 4
    }

    exit $mainExitCode
}
