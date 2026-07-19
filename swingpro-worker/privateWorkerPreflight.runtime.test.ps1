#requires -Version 5.1
<#
Offline, black-box RUNTIME verification harness for
scripts/private-worker-preflight.ps1.

This harness actually EXECUTES the real preflight script as a child
process against a temporary, synthetic `gcloud` executable that this
harness creates and tears down entirely inside the OS temp directory
(never inside this repository). It never contacts Google Cloud,
Supabase, Gemini, Vercel, or any other network service; never invokes
the real gcloud; never uses Docker; never deploys, migrates, or
creates any cloud resource; never reads real credentials; and never
commits or pushes anything. See PRIVATE_WORKER_PREFLIGHT_RUNTIME_TESTS.md
for the full contract this harness proves.

Run with Windows PowerShell 5.1:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File privateWorkerPreflight.runtime.test.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------

$script:RuntimeTestRoot = $PSScriptRoot
$script:ProductionScriptPath = Join-Path -Path $script:RuntimeTestRoot -ChildPath 'scripts\private-worker-preflight.ps1'
$script:RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path -Path $script:RuntimeTestRoot -ChildPath '..')).Path

if (-not (Test-Path -LiteralPath $script:ProductionScriptPath -PathType Leaf)) {
    [Console]::Error.WriteLine("FATAL: production script not found at $script:ProductionScriptPath")
    exit 2
}

$script:SandboxRoot = $null
$script:OriginalPath = $env:PATH
$script:OriginalCloudSdkAuthValues = @{}

# ----------------------------------------------------------------------
# Assertion framework
# ----------------------------------------------------------------------

$script:AssertionResults = New-Object System.Collections.Generic.List[object]

function Assert-That {
    param(
        [Parameter(Mandatory)] [bool] $Condition,
        [Parameter(Mandatory)] [string] $Name
    )
    $entry = [pscustomobject]@{ Name = $Name; Passed = $Condition }
    $script:AssertionResults.Add($entry) | Out-Null
    if ($Condition) {
        Write-Host "  PASS: $Name"
    }
    else {
        Write-Host "  FAIL: $Name"
    }
}

function Write-ScenarioHeader {
    param([string] $Name)
    Write-Host ''
    Write-Host "=== Scenario: $Name ==="
}

# ----------------------------------------------------------------------
# Sandbox setup: synthetic gcloud executable, entirely outside the repo
# ----------------------------------------------------------------------

function New-Sandbox {
    $root = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("swingproai-preflight-runtime-" + [guid]::NewGuid().ToString('N'))

    # Absolute safety: the sandbox must never be inside the repository root.
    $canonicalRoot = [System.IO.Path]::GetFullPath($root)
    $canonicalRepoRoot = [System.IO.Path]::GetFullPath($script:RepositoryRoot)
    $repoRootWithSeparator = $canonicalRepoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if ($canonicalRoot.StartsWith($repoRootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to create sandbox inside the repository root.'
    }

    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $binDir = Join-Path -Path $root -ChildPath 'bin'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $scenariosDir = Join-Path -Path $root -ChildPath 'scenarios'
    New-Item -ItemType Directory -Path $scenariosDir -Force | Out-Null

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    # Thin batch launcher: forwards all arguments to the PowerShell
    # dispatcher and propagates its exit code exactly.
    $gcloudCmdPath = Join-Path -Path $binDir -ChildPath 'gcloud.cmd'
    $launcherContent = "@echo off`r`npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0gcloud-dispatcher.ps1`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    [System.IO.File]::WriteAllText($gcloudCmdPath, $launcherContent, $utf8NoBom)

    $dispatcherPath = Join-Path -Path $binDir -ChildPath 'gcloud-dispatcher.ps1'
    [System.IO.File]::WriteAllText($dispatcherPath, (Get-DispatcherScriptContent), $utf8NoBom)

    return [pscustomobject]@{
        Root         = $root
        BinDir       = $binDir
        ScenariosDir = $scenariosDir
        GcloudCmd    = $gcloudCmdPath
        Dispatcher   = $dispatcherPath
    }
}

function Get-DispatcherScriptContent {
    # Single-quoted here-string: no interpolation, this is literal
    # PowerShell source written verbatim into gcloud-dispatcher.ps1.
    return @'
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ArgList
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($null -eq $ArgList) { $ArgList = @() }

$fixtureRoot = $env:RUNTIME_HARNESS_FIXTURE_DIR
if ([string]::IsNullOrEmpty($fixtureRoot)) {
    [Console]::Error.WriteLine('RUNTIME-FIXTURE-DISPATCHER: RUNTIME_HARNESS_FIXTURE_DIR is not set.')
    exit 90
}

$logPath = Join-Path -Path $fixtureRoot -ChildPath 'invocation-log.jsonl'
try {
    $logEntry = [ordered]@{
        timestampUtc = (Get-Date).ToUniversalTime().ToString('o')
        arguments    = @($ArgList)
    }
    ($logEntry | ConvertTo-Json -Compress -Depth 10) | Add-Content -LiteralPath $logPath -Encoding UTF8
}
catch {
    [Console]::Error.WriteLine('RUNTIME-FIXTURE-DISPATCHER: failed to write invocation log.')
    exit 91
}

# Defense-in-depth allowlist mirroring the production script's own
# read-only contract: this synthetic gcloud must never let a mutating
# or auth-overriding command through, even by accident of a future
# harness change.
$forbiddenExactTokens = @(
    'create', 'update', 'delete', 'deploy', 'submit',
    'add-iam-policy-binding', 'remove-iam-policy-binding', 'set-iam-policy',
    'resume', 'pause', 'access'
)
foreach ($token in $ArgList) {
    foreach ($forbidden in $forbiddenExactTokens) {
        if ($token -ceq $forbidden) {
            [Console]::Error.WriteLine("RUNTIME-FIXTURE-DISPATCHER: forbidden token rejected: $forbidden")
            exit 92
        }
    }
}

$forbiddenFlags = @(
    '--impersonate-service-account', '--access-token-file', '--credential-file-override',
    '--account', '--configuration', '--billing-project', '--flags-file',
    '--trace-token', '--log-http'
)
foreach ($token in $ArgList) {
    foreach ($forbiddenFlag in $forbiddenFlags) {
        if ($token -ceq $forbiddenFlag -or $token.StartsWith("$forbiddenFlag=", [System.StringComparison]::Ordinal)) {
            [Console]::Error.WriteLine("RUNTIME-FIXTURE-DISPATCHER: forbidden flag rejected: $forbiddenFlag")
            exit 93
        }
    }
}

# Known read-only command families, mirroring the production allowlist
# exactly: (path tokens, whether a positional resource identifier
# immediately follows the path).
$families = @(
    @{ Path = @('version'); HasPositional = $false }
    @{ Path = @('auth', 'list'); HasPositional = $false }
    @{ Path = @('config', 'list'); HasPositional = $false }
    @{ Path = @('projects', 'describe'); HasPositional = $true }
    @{ Path = @('projects', 'get-iam-policy'); HasPositional = $true }
    @{ Path = @('services', 'list'); HasPositional = $false }
    @{ Path = @('artifacts', 'repositories', 'list'); HasPositional = $false }
    @{ Path = @('artifacts', 'repositories', 'describe'); HasPositional = $true }
    @{ Path = @('artifacts', 'repositories', 'get-iam-policy'); HasPositional = $true }
    @{ Path = @('run', 'services', 'list'); HasPositional = $false }
    @{ Path = @('run', 'services', 'describe'); HasPositional = $true }
    @{ Path = @('run', 'services', 'get-iam-policy'); HasPositional = $true }
    @{ Path = @('iam', 'service-accounts', 'list'); HasPositional = $false }
    @{ Path = @('iam', 'service-accounts', 'describe'); HasPositional = $true }
    @{ Path = @('iam', 'service-accounts', 'get-iam-policy'); HasPositional = $true }
    @{ Path = @('secrets', 'list'); HasPositional = $false }
    @{ Path = @('secrets', 'describe'); HasPositional = $true }
    @{ Path = @('secrets', 'versions', 'list'); HasPositional = $true }
    @{ Path = @('secrets', 'get-iam-policy'); HasPositional = $true }
    @{ Path = @('tasks', 'queues', 'list'); HasPositional = $false }
    @{ Path = @('tasks', 'queues', 'describe'); HasPositional = $true }
    @{ Path = @('tasks', 'queues', 'get-iam-policy'); HasPositional = $true }
)

$matchedFamily = $null
foreach ($family in $families) {
    $path = $family.Path
    if ($ArgList.Count -lt $path.Count) { continue }
    $isMatch = $true
    for ($i = 0; $i -lt $path.Count; $i++) {
        if ($ArgList[$i] -cne $path[$i]) { $isMatch = $false; break }
    }
    if ($isMatch) { $matchedFamily = $family; break }
}

if ($null -eq $matchedFamily) {
    [Console]::Error.WriteLine('RUNTIME-FIXTURE-DISPATCHER: no known read-only command family matched.')
    exit 94
}

$fixtureKey = ($matchedFamily.Path -join '-')
if ($matchedFamily.HasPositional) {
    $positionalIndex = $matchedFamily.Path.Count
    if ($ArgList.Count -le $positionalIndex) {
        [Console]::Error.WriteLine('RUNTIME-FIXTURE-DISPATCHER: expected positional argument missing.')
        exit 95
    }
    $positionalValue = $ArgList[$positionalIndex]
    $sanitized = ($positionalValue -creplace '[^A-Za-z0-9\-]', '_')
    $fixtureKey = "$fixtureKey--$sanitized"
}

$fixtureFile = Join-Path -Path (Join-Path -Path $fixtureRoot -ChildPath 'fixtures') -ChildPath "$fixtureKey.json"
if (-not (Test-Path -LiteralPath $fixtureFile -PathType Leaf)) {
    [Console]::Error.WriteLine("RUNTIME-FIXTURE-DISPATCHER: no fixture registered for key '$fixtureKey'.")
    exit 96
}

$envelopeText = Get-Content -LiteralPath $fixtureFile -Raw
$envelope = $envelopeText | ConvertFrom-Json

$exitCodeToUse = 0
if ($null -ne $envelope.ExitCode) { $exitCodeToUse = [int]$envelope.ExitCode }

if ($envelope.Stdout) {
    [Console]::Out.Write([string]$envelope.Stdout)
}
if ($envelope.Stderr) {
    [Console]::Error.Write([string]$envelope.Stderr)
}

exit $exitCodeToUse
'@
}

function Remove-Sandbox {
    param([string] $Root)
    if ($Root -and (Test-Path -LiteralPath $Root)) {
        try {
            Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Host "WARNING: failed to remove sandbox at $Root : $($_.Exception.Message)"
        }
    }
}

# ----------------------------------------------------------------------
# Positive pre-execution resolution verification (run inside a CHILD
# process, using exactly the environment the real preflight child will
# receive) — the harness must never invoke the real preflight unless
# this check proves the exact first Application-or-ExternalScript candidate
# production would select is our synthetic executable.
# ----------------------------------------------------------------------

# Mirrors production's Resolve-GcloudCommand exactly: Get-Command -All,
# filtered to CommandType Application-or-ExternalScript with the returned
# order preserved, first accepted candidate selected. This is deliberately
# NOT "is the synthetic Application present somewhere in the candidate
# list" — an ExternalScript (e.g. a real Google Cloud SDK's own gcloud.ps1,
# or a rogue script) earlier on PATH than the synthetic gcloud.cmd would be
# silently skipped by an Application-only filter, even though production's
# own resolver would select — and execute — that earlier candidate instead
# of ever reaching the synthetic one. The probe never invokes the selected
# candidate; it only inspects Get-Command metadata (Source, CommandType).
function Get-ChildGcloudSelection {
    $probeArgs = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        '$candidates = @(Get-Command -Name gcloud -All -ErrorAction SilentlyContinue); ' +
        '$accepted = @($candidates | Where-Object { $_.CommandType -ceq ''Application'' -or $_.CommandType -ceq ''ExternalScript'' }); ' +
        'if ($accepted.Count -gt 0) { ' +
        '$selected = $accepted[0]; ' +
        '[pscustomobject]@{ Selected = $true; Source = $selected.Source; CommandType = $selected.CommandType.ToString() } | ConvertTo-Json -Compress ' +
        '} else { ' +
        '[pscustomobject]@{ Selected = $false; Source = $null; CommandType = $null } | ConvertTo-Json -Compress ' +
        '}'
    )
    # Native-command stderr redirection under $ErrorActionPreference = 'Stop'
    # raises a terminating NativeCommandError in Windows PowerShell for any
    # stderr output at all — the same hazard the production script's own
    # Invoke-ReadOnlyGcloudCommand guards against with its own try/catch
    # around exactly this kind of call.
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $probeOutput = ''
    try {
        $stdoutLines = & 'powershell.exe' @probeArgs 2>$null
        $probeOutput = ($stdoutLines -join '').Trim()
    }
    catch {
        $probeOutput = ''
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    try {
        return ($probeOutput | ConvertFrom-Json)
    }
    catch {
        return [pscustomobject]@{ Selected = $false; Source = $null; CommandType = $null }
    }
}

function Test-ChildResolvesToSyntheticGcloud {
    param([string] $ExpectedGcloudCmdPath)

    $selection = Get-ChildGcloudSelection
    if (-not $selection.Selected) { return $false }
    if ([string]::IsNullOrEmpty($selection.Source)) { return $false }

    # Canonicalize both sides before comparing — GetFullPath normalizes
    # relative segments and separators the same way for both the candidate
    # Get-Command reported and the expected synthetic path, so this is
    # never a brittle raw-string comparison.
    $canonicalSelected = [System.IO.Path]::GetFullPath($selection.Source)
    $canonicalExpected = [System.IO.Path]::GetFullPath($ExpectedGcloudCmdPath)
    if (-not $canonicalSelected.Equals($canonicalExpected, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    # The synthetic sandbox executable is gcloud.cmd — an Application, never
    # an ExternalScript. Requiring this exact CommandType (in addition to
    # the Source match) means a same-path coincidence of a different
    # command type could never be mistaken for the verified synthetic
    # candidate.
    if ($selection.CommandType -cne 'Application') { return $false }

    return $true
}

# ----------------------------------------------------------------------
# Fixture helpers
# ----------------------------------------------------------------------

function New-FixtureEnvelope {
    param(
        [Parameter(Mandatory)] $StdoutObject,
        [int] $ExitCode = 0,
        [string] $Stderr = ''
    )
    $stdoutJson = $StdoutObject | ConvertTo-Json -Depth 25 -Compress
    return [pscustomobject]@{
        ExitCode = $ExitCode
        Stdout   = $stdoutJson
        Stderr   = $Stderr
    }
}

function Write-Fixture {
    param(
        [Parameter(Mandatory)] [string] $FixturesDir,
        [Parameter(Mandatory)] [string] $Key,
        [Parameter(Mandatory)] $Envelope
    )
    $path = Join-Path -Path $FixturesDir -ChildPath "$Key.json"
    $json = $Envelope | ConvertTo-Json -Depth 25
    Set-Content -LiteralPath $path -Value $json -Encoding UTF8 -NoNewline
}

# ----------------------------------------------------------------------
# Synthetic scenario identity constants (all fake — never real accounts,
# projects, service accounts, or secrets)
# ----------------------------------------------------------------------

$script:ActiveAccount = 'synthetic-user@example.invalid'
$script:ProjectNumber = '999999000111'
$script:CloudTasksServiceAgent = "service-$($script:ProjectNumber)@gcp-sa-cloudtasks.iam.gserviceaccount.com"

function New-CleanConfigListStdout {
    return [ordered]@{
        core = [ordered]@{ account = $script:ActiveAccount }
        auth = [ordered]@{}
    }
}

function New-CleanAuthListStdout {
    return @(
        [ordered]@{ account = $script:ActiveAccount; status = 'ACTIVE' }
    )
}

function New-CleanEnabledServicesStdout {
    $apis = @(
        'run.googleapis.com', 'cloudtasks.googleapis.com', 'artifactregistry.googleapis.com',
        'secretmanager.googleapis.com', 'cloudbuild.googleapis.com', 'iam.googleapis.com',
        'iamcredentials.googleapis.com', 'serviceusage.googleapis.com'
    )
    return @($apis | ForEach-Object { [ordered]@{ config = [ordered]@{ name = $_ } } })
}

function New-EmptyIamPolicyStdout {
    return [ordered]@{ bindings = @() }
}

# ----------------------------------------------------------------------
# Scenario execution
# ----------------------------------------------------------------------

function Invoke-Scenario {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [hashtable] $Fixtures,
        [Parameter(Mandatory)] [hashtable] $CliParams,
        [hashtable] $ExtraEnv = @{},
        [switch] $SkipGcloudResolutionCheck,
        # Prepended before the synthetic sandbox bin directory when set —
        # used only by the rogue-candidate regression to prove a full
        # scenario aborts correctly when something else on PATH would
        # resolve ahead of the synthetic executable. Every existing caller
        # omits this, leaving PATH construction byte-for-byte identical to
        # before this parameter existed.
        [string] $PathPrefix = '',
        # When set, this scenario is deliberately expected to fail gcloud
        # resolution (a rogue-candidate regression) — the resolution
        # assertion below is inverted so a correctly-detected failure is
        # itself recorded as a PASSING assertion, rather than an aborted
        # scenario dragging down the overall harness pass count for
        # behavior it was specifically constructed to exercise. Every
        # existing caller omits this, leaving normal-scenario assertion
        # behavior byte-for-byte identical to before this parameter existed.
        [switch] $ExpectResolutionFailure
    )

    Write-ScenarioHeader -Name $Name

    $scenarioDir = Join-Path -Path $script:Sandbox.ScenariosDir -ChildPath ($Name -replace '[^A-Za-z0-9\-]', '_')
    New-Item -ItemType Directory -Path $scenarioDir -Force | Out-Null
    $fixturesDir = Join-Path -Path $scenarioDir -ChildPath 'fixtures'
    New-Item -ItemType Directory -Path $fixturesDir -Force | Out-Null
    $logPath = Join-Path -Path $scenarioDir -ChildPath 'invocation-log.jsonl'
    New-Item -ItemType File -Path $logPath -Force | Out-Null

    foreach ($key in $Fixtures.Keys) {
        Write-Fixture -FixturesDir $fixturesDir -Key $key -Envelope $Fixtures[$key]
    }

    $outputPath = Join-Path -Path $scenarioDir -ChildPath 'report.json'
    $stdoutPath = Join-Path -Path $scenarioDir -ChildPath 'stdout.txt'
    $stderrPath = Join-Path -Path $scenarioDir -ChildPath 'stderr.txt'

    # Snapshot and clear any CLOUDSDK_AUTH_* variables already present in
    # this session so a clean scenario cannot accidentally inherit a
    # stray override left by the developer's own shell, then restore them
    # (and apply this scenario's ExtraEnv) afterward.
    $preExistingCloudSdkAuthVars = @{}
    Get-ChildItem -Path Env: | Where-Object { $_.Name -match '^CLOUDSDK_AUTH_' } | ForEach-Object {
        $preExistingCloudSdkAuthVars[$_.Name] = $_.Value
        Remove-Item -Path "Env:$($_.Name)" -ErrorAction SilentlyContinue
    }

    $pathPrefixSegment = if ($PathPrefix) { "$PathPrefix;" } else { '' }
    $env:PATH = "$pathPrefixSegment$($script:Sandbox.BinDir);$($script:OriginalPath)"
    $env:RUNTIME_HARNESS_FIXTURE_DIR = $scenarioDir
    foreach ($key in $ExtraEnv.Keys) {
        Set-Item -Path "Env:$key" -Value $ExtraEnv[$key]
    }

    try {
        if (-not $SkipGcloudResolutionCheck) {
            $resolvesCorrectly = Test-ChildResolvesToSyntheticGcloud -ExpectedGcloudCmdPath $script:Sandbox.GcloudCmd
            if ($ExpectResolutionFailure) {
                Assert-That -Condition (-not $resolvesCorrectly) -Name "$Name : child process resolution correctly fails (expected - a rogue candidate precedes the synthetic executable)"
            }
            else {
                Assert-That -Condition $resolvesCorrectly -Name "$Name : child process resolves gcloud to the synthetic sandbox executable"
            }
            if (-not $resolvesCorrectly) {
                Write-Host "  ABORT: refusing to invoke the real preflight script for scenario '$Name' because gcloud resolution could not be positively verified."
                return $null
            }
        }

        $childArgs = @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', $script:ProductionScriptPath,
            '-ProjectId', $CliParams.ProjectId,
            '-Region', $CliParams.Region,
            '-TasksLocation', $CliParams.TasksLocation,
            '-OutputPath', $outputPath
        )
        foreach ($optionalParamName in @('WorkerServiceName', 'ArtifactRepository', 'QueueName', 'RuntimeServiceAccount', 'TaskCallerServiceAccount', 'TaskCreatorServiceAccount', 'SupabaseSecretName', 'GeminiSecretName')) {
            if ($CliParams.ContainsKey($optionalParamName) -and $CliParams[$optionalParamName]) {
                $childArgs += @("-$optionalParamName", $CliParams[$optionalParamName])
            }
        }

        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $exitCode = $null
        $stdoutText = ''
        try {
            $stdoutLines = & 'powershell.exe' @childArgs 2>$stderrPath
            $exitCode = $LASTEXITCODE
            $stdoutText = ($stdoutLines -join "`n")
        }
        catch {
            $exitCode = -1
            $stdoutText = ''
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        Set-Content -LiteralPath $stdoutPath -Value $stdoutText -Encoding UTF8 -NoNewline

        $stderrText = ''
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
            $stderrText = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
            if (-not $stderrText) { $stderrText = '' }
        }

        $reportText = $null
        if (Test-Path -LiteralPath $outputPath -PathType Leaf) {
            $reportText = Get-Content -LiteralPath $outputPath -Raw
        }

        $invocationLogLines = @()
        if (Test-Path -LiteralPath $logPath -PathType Leaf) {
            $invocationLogLines = @(Get-Content -LiteralPath $logPath | Where-Object { $_.Trim().Length -gt 0 })
        }

        return [pscustomobject]@{
            Name             = $Name
            ExitCode         = $exitCode
            StdoutText       = $stdoutText
            StderrText       = $stderrText
            ReportText       = $reportText
            ReportPath       = $outputPath
            InvocationLog    = $invocationLogLines
            CliParams        = $CliParams
        }
    }
    finally {
        Remove-Item -Path 'Env:RUNTIME_HARNESS_FIXTURE_DIR' -ErrorAction SilentlyContinue
        foreach ($key in $ExtraEnv.Keys) {
            Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue
        }
        foreach ($name in $preExistingCloudSdkAuthVars.Keys) {
            Set-Item -Path "Env:$name" -Value $preExistingCloudSdkAuthVars[$name]
        }
    }
}

# ----------------------------------------------------------------------
# Report-safety and command-containment assertions
# ----------------------------------------------------------------------

function Test-TextDoesNotContainAny {
    param([string] $Text, [string[]] $Sentinels)
    if ([string]::IsNullOrEmpty($Text)) { return $true }
    foreach ($sentinel in $Sentinels) {
        if ($Text.IndexOf($sentinel, [System.StringComparison]::Ordinal) -ge 0) { return $false }
    }
    return $true
}

function Assert-NoSentinelLeakage {
    param(
        [Parameter(Mandatory)] $Result,
        [Parameter(Mandatory)] [string[]] $Sentinels,
        [Parameter(Mandatory)] [string] $ScenarioName
    )
    Assert-That -Condition (Test-TextDoesNotContainAny -Text $Result.ReportText -Sentinels $Sentinels) -Name "$ScenarioName : report JSON does not contain any sentinel value"
    Assert-That -Condition (Test-TextDoesNotContainAny -Text $Result.StdoutText -Sentinels $Sentinels) -Name "$ScenarioName : preflight stdout does not contain any sentinel value"
    Assert-That -Condition (Test-TextDoesNotContainAny -Text $Result.StderrText -Sentinels $Sentinels) -Name "$ScenarioName : preflight stderr does not contain any sentinel value"
}

function Assert-CommandContainment {
    param(
        [Parameter(Mandatory)] $Result,
        [Parameter(Mandatory)] [string] $ScenarioName
    )
    $forbiddenExact = @('create', 'update', 'delete', 'deploy', 'submit', 'add-iam-policy-binding', 'remove-iam-policy-binding', 'set-iam-policy', 'resume', 'pause', 'access')
    $forbiddenFlags = @('--impersonate-service-account', '--access-token-file', '--credential-file-override', '--account', '--configuration', '--billing-project', '--flags-file', '--trace-token', '--log-http')

    $allClean = $true
    $projectValuesMatch = $true
    $regionOrLocationValuesMatch = $true

    foreach ($line in $Result.InvocationLog) {
        $entry = $line | ConvertFrom-Json
        $args = @($entry.arguments)

        foreach ($token in $args) {
            if ($forbiddenExact -ccontains $token) { $allClean = $false }
            foreach ($flag in $forbiddenFlags) {
                if ($token -ceq $flag -or $token.StartsWith("$flag=", [System.StringComparison]::Ordinal)) { $allClean = $false }
            }
        }

        for ($i = 0; $i -lt $args.Count; $i++) {
            if ($args[$i] -ceq '--project' -and ($i + 1) -lt $args.Count) {
                if ($args[$i + 1] -cne $Result.CliParams.ProjectId) { $projectValuesMatch = $false }
            }
            if ($args[$i] -ceq '--region' -and ($i + 1) -lt $args.Count) {
                if ($args[$i + 1] -cne $Result.CliParams.Region) { $regionOrLocationValuesMatch = $false }
            }
            if ($args[$i] -ceq '--location' -and ($i + 1) -lt $args.Count) {
                $locationValue = $args[$i + 1]
                if (($locationValue -cne $Result.CliParams.Region) -and ($locationValue -cne $Result.CliParams.TasksLocation)) {
                    $regionOrLocationValuesMatch = $false
                }
            }
        }
    }

    Assert-That -Condition ($Result.InvocationLog.Count -gt 0) -Name "$ScenarioName : at least one gcloud invocation was recorded"
    Assert-That -Condition $allClean -Name "$ScenarioName : no forbidden mutating command or auth-override flag was ever invoked"
    Assert-That -Condition $projectValuesMatch -Name "$ScenarioName : every --project value exactly matches the configured ProjectId"
    Assert-That -Condition $regionOrLocationValuesMatch -Name "$ScenarioName : every --region/--location value exactly matches the configured Region/TasksLocation"
}

function Get-ParsedReport {
    param($Result)
    if ([string]::IsNullOrEmpty($Result.ReportText)) { return $null }
    return $Result.ReportText | ConvertFrom-Json
}

# ----------------------------------------------------------------------
# Harness bootstrap
# ----------------------------------------------------------------------

try {
    $script:Sandbox = New-Sandbox
}
catch {
    [Console]::Error.WriteLine("FATAL: could not establish the synthetic gcloud sandbox: $($_.Exception.Message)")
    exit 2
}

try {
    $env:PATH = "$($script:Sandbox.BinDir);$($script:OriginalPath)"
    $initialResolution = Test-ChildResolvesToSyntheticGcloud -ExpectedGcloudCmdPath $script:Sandbox.GcloudCmd
    if (-not $initialResolution) {
        [Console]::Error.WriteLine('FATAL: initial gcloud resolution check failed — the synthetic sandbox executable is not resolved by a child process. Aborting before running any scenario.')
        exit 2
    }
    Write-Host "Sandbox established at: $($script:Sandbox.Root)"
    Write-Host 'Initial gcloud resolution check: PASS (child process resolves to the synthetic sandbox executable)'

    # ====================================================================
    # Scenario A: clean, required-discovery-only run
    # ====================================================================
    $aProjectId = 'synthetic-project-a'
    $aRegion = 'synthetic-region-a'
    $aTasksLocation = 'synthetic-region-a'

    $aFixtures = @{
        'version'                       = New-FixtureEnvelope -StdoutObject @{ 'Google Cloud SDK' = '999.0.0' }
        'auth-list'                     = New-FixtureEnvelope -StdoutObject (New-CleanAuthListStdout)
        'config-list'                   = New-FixtureEnvelope -StdoutObject (New-CleanConfigListStdout)
        'projects-describe--synthetic-project-a' = New-FixtureEnvelope -StdoutObject @{ projectId = $aProjectId; lifecycleState = 'ACTIVE'; projectNumber = $script:ProjectNumber }
        'projects-get-iam-policy--synthetic-project-a' = New-FixtureEnvelope -StdoutObject (New-EmptyIamPolicyStdout)
        'services-list'                 = New-FixtureEnvelope -StdoutObject (New-CleanEnabledServicesStdout)
        'artifacts-repositories-list'    = New-FixtureEnvelope -StdoutObject @(@{ name = 'synthetic-repo'; format = 'DOCKER' })
        'run-services-list'              = New-FixtureEnvelope -StdoutObject @()
        'iam-service-accounts-list'      = New-FixtureEnvelope -StdoutObject @()
        'secrets-list'                   = New-FixtureEnvelope -StdoutObject @()
        'tasks-queues-list'              = New-FixtureEnvelope -StdoutObject @()
    }

    $aResult = Invoke-Scenario -Name 'A-clean-required-discovery' -Fixtures $aFixtures -CliParams @{
        ProjectId     = $aProjectId
        Region        = $aRegion
        TasksLocation = $aTasksLocation
    }

    if ($aResult) {
        Assert-That -Condition ($aResult.ExitCode -eq 0) -Name 'A : exit code is 0 (no blockers)'
        $aReport = Get-ParsedReport -Result $aResult
        Assert-That -Condition ($null -ne $aReport -and @($aReport.blockers).Count -eq 0) -Name 'A : report contains zero blockers'
        Assert-That -Condition ($null -ne $aReport -and $aReport.mode -eq 'read-only') -Name 'A : report mode is read-only'
        Assert-CommandContainment -Result $aResult -ScenarioName 'A'
        Assert-That -Condition ($aResult.InvocationLog.Count -eq 11) -Name 'A : exactly the 11 generic discovery commands were invoked, no targeted commands'
        # A's tasks-queues-list fixture returns zero queues (an empty JSON
        # array, which Windows PowerShell 5.1's ConvertFrom-Json itself
        # normalizes to $null before the Cloud Tasks queues check ever runs)
        # — this is exactly the Defect 4 reproduction shape. A's exit-0/
        # zero-blockers assertions above already prove the queues check no
        # longer throws; this additionally proves zero queues produces no
        # spurious "multiple candidate queues" warning either.
        Assert-That -Condition ($null -ne $aReport -and -not (@($aReport.warnings) -contains 'multiple candidate queues')) -Name 'A (Defect 4 / zero queues) : no "multiple candidate queues" warning is produced for zero queues, and no exception occurred reaching this point'
    }

    # ====================================================================
    # Scenario B: clean, full-target scenario (all 8 optional params)
    # ====================================================================
    $bProjectId = 'synthetic-project-b'
    $bRegion = 'synthetic-region-b'
    $bTasksLocation = 'synthetic-loc-b'
    $bWorkerServiceName = 'synthetic-worker-svc'
    $bArtifactRepository = 'synthetic-artifact-repo'
    $bQueueName = 'synthetic-queue'
    $bRuntimeSa = "synthetic-runtime-sa@$bProjectId.iam.gserviceaccount.com"
    $bCallerSa = "synthetic-caller-sa@$bProjectId.iam.gserviceaccount.com"
    $bCreatorSa = "synthetic-creator-sa@$bProjectId.iam.gserviceaccount.com"
    $bSupabaseSecretName = 'synthetic-supabase-secret'
    $bGeminiSecretName = 'synthetic-gemini-secret'
    $bCloudTasksAgentMember = "serviceAccount:$($script:CloudTasksServiceAgent)"

    function New-BScenarioFixtures {
        param(
            [string] $WorkerServiceIamPolicyStdoutOverride = $null,
            [string] $ProjectIamPolicyStdoutOverride = $null
        )

        $projectIamPolicyStdout = [ordered]@{
            bindings = @(
                [ordered]@{ role = 'roles/cloudtasks.serviceAgent'; members = @($bCloudTasksAgentMember) }
            )
        }

        $workerServiceIamPolicyStdout = [ordered]@{
            bindings = @(
                [ordered]@{ role = 'roles/run.invoker'; members = @("serviceAccount:$bCallerSa") }
            )
        }

        $fixtures = @{
            'version'                     = New-FixtureEnvelope -StdoutObject @{ 'Google Cloud SDK' = '999.0.0' }
            'auth-list'                   = New-FixtureEnvelope -StdoutObject (New-CleanAuthListStdout)
            'config-list'                 = New-FixtureEnvelope -StdoutObject (New-CleanConfigListStdout)
            "projects-describe--$bProjectId" = New-FixtureEnvelope -StdoutObject @{ projectId = $bProjectId; lifecycleState = 'ACTIVE'; projectNumber = $script:ProjectNumber }
            "projects-get-iam-policy--$bProjectId" = New-FixtureEnvelope -StdoutObject $projectIamPolicyStdout
            'services-list'               = New-FixtureEnvelope -StdoutObject (New-CleanEnabledServicesStdout)
            'artifacts-repositories-list' = New-FixtureEnvelope -StdoutObject @(@{ name = $bArtifactRepository; format = 'DOCKER' })
            "artifacts-repositories-describe--$bArtifactRepository" = New-FixtureEnvelope -StdoutObject @{ name = $bArtifactRepository; format = 'DOCKER' }
            "artifacts-repositories-get-iam-policy--$bArtifactRepository" = New-FixtureEnvelope -StdoutObject (New-EmptyIamPolicyStdout)
            'run-services-list'           = New-FixtureEnvelope -StdoutObject @(@{ name = $bWorkerServiceName; ingress = 'INGRESS_TRAFFIC_INTERNAL_ONLY' })
            "run-services-describe--$bWorkerServiceName" = New-FixtureEnvelope -StdoutObject @{
                name              = $bWorkerServiceName
                uri               = "https://$bWorkerServiceName-xyz.a.run.app"
                ingress           = 'INGRESS_TRAFFIC_INTERNAL_ONLY'
                invokerIamDisabled = $false
                template          = [ordered]@{
                    serviceAccount = $bRuntimeSa
                    containers     = @(@{ image = "$bRegion-docker.pkg.dev/$bProjectId/$bArtifactRepository/worker@sha256:0000000000000000000000000000000000000000000000000000000000aa" })
                }
                latestReadyRevision = "$bWorkerServiceName-00001"
                traffic           = @(@{ revisionName = "$bWorkerServiceName-00001"; percent = 100 })
            }
            "run-services-get-iam-policy--$bWorkerServiceName" = New-FixtureEnvelope -StdoutObject $workerServiceIamPolicyStdout
            'iam-service-accounts-list'   = New-FixtureEnvelope -StdoutObject @()
            "iam-service-accounts-describe--$($bRuntimeSa -creplace '[^A-Za-z0-9\-]', '_')" = New-FixtureEnvelope -StdoutObject @{ email = $bRuntimeSa; disabled = $false }
            "iam-service-accounts-get-iam-policy--$($bRuntimeSa -creplace '[^A-Za-z0-9\-]', '_')" = New-FixtureEnvelope -StdoutObject (New-EmptyIamPolicyStdout)
            "iam-service-accounts-describe--$($bCallerSa -creplace '[^A-Za-z0-9\-]', '_')" = New-FixtureEnvelope -StdoutObject @{ email = $bCallerSa; disabled = $false }
            "iam-service-accounts-get-iam-policy--$($bCallerSa -creplace '[^A-Za-z0-9\-]', '_')" = New-FixtureEnvelope -StdoutObject (
                [ordered]@{
                    bindings = @(
                        [ordered]@{ role = 'roles/iam.serviceAccountUser'; members = @("serviceAccount:$bCreatorSa") }
                        [ordered]@{ role = 'roles/iam.serviceAccountUser'; members = @($bCloudTasksAgentMember) }
                    )
                }
            )
            "iam-service-accounts-describe--$($bCreatorSa -creplace '[^A-Za-z0-9\-]', '_')" = New-FixtureEnvelope -StdoutObject @{ email = $bCreatorSa; disabled = $false }
            "iam-service-accounts-get-iam-policy--$($bCreatorSa -creplace '[^A-Za-z0-9\-]', '_')" = New-FixtureEnvelope -StdoutObject (New-EmptyIamPolicyStdout)
            'secrets-list'                = New-FixtureEnvelope -StdoutObject @()
            "secrets-describe--$bSupabaseSecretName" = New-FixtureEnvelope -StdoutObject @{ name = $bSupabaseSecretName }
            "secrets-versions-list--$bSupabaseSecretName" = New-FixtureEnvelope -StdoutObject @(@{ name = "projects/$bProjectId/secrets/$bSupabaseSecretName/versions/1"; state = 'ENABLED' })
            "secrets-get-iam-policy--$bSupabaseSecretName" = New-FixtureEnvelope -StdoutObject (
                [ordered]@{ bindings = @(@{ role = 'roles/secretmanager.secretAccessor'; members = @("serviceAccount:$bRuntimeSa") }) }
            )
            "secrets-describe--$bGeminiSecretName" = New-FixtureEnvelope -StdoutObject @{ name = $bGeminiSecretName }
            "secrets-versions-list--$bGeminiSecretName" = New-FixtureEnvelope -StdoutObject @(@{ name = "projects/$bProjectId/secrets/$bGeminiSecretName/versions/1"; state = 'ENABLED' })
            "secrets-get-iam-policy--$bGeminiSecretName" = New-FixtureEnvelope -StdoutObject (
                [ordered]@{ bindings = @(@{ role = 'roles/secretmanager.secretAccessor'; members = @("serviceAccount:$bRuntimeSa") }) }
            )
            'tasks-queues-list'           = New-FixtureEnvelope -StdoutObject @(@{ name = $bQueueName; state = 'PAUSED' })
            "tasks-queues-describe--$bQueueName" = New-FixtureEnvelope -StdoutObject @{ name = $bQueueName; state = 'PAUSED' }
            "tasks-queues-get-iam-policy--$bQueueName" = New-FixtureEnvelope -StdoutObject (
                [ordered]@{ bindings = @(@{ role = 'roles/cloudtasks.enqueuer'; members = @("serviceAccount:$bCreatorSa") }) }
            )
        }
        return $fixtures
    }

    $bCliParams = @{
        ProjectId                 = $bProjectId
        Region                    = $bRegion
        TasksLocation             = $bTasksLocation
        WorkerServiceName         = $bWorkerServiceName
        ArtifactRepository        = $bArtifactRepository
        QueueName                 = $bQueueName
        RuntimeServiceAccount     = $bRuntimeSa
        TaskCallerServiceAccount  = $bCallerSa
        TaskCreatorServiceAccount = $bCreatorSa
        SupabaseSecretName        = $bSupabaseSecretName
        GeminiSecretName           = $bGeminiSecretName
    }

    $bResult = Invoke-Scenario -Name 'B-clean-full-target' -Fixtures (New-BScenarioFixtures) -CliParams $bCliParams

    if ($bResult) {
        Assert-That -Condition ($bResult.ExitCode -eq 0) -Name 'B : exit code is 0 (no blockers) across the full 22-command matrix'
        $bReport = Get-ParsedReport -Result $bResult
        Assert-That -Condition ($null -ne $bReport -and @($bReport.blockers).Count -eq 0) -Name 'B : report contains zero blockers'
        Assert-CommandContainment -Result $bResult -ScenarioName 'B'
        # 29 total invocations: 11 generic + 2 each for worker service /
        # artifact repository / queue + 2 calls x 3 service accounts + 3
        # calls x 2 secrets = 11 + 2 + 2 + 2 + 6 + 6 = 29.
        Assert-That -Condition ($bResult.InvocationLog.Count -eq 29) -Name 'B : exactly 29 gcloud invocations occurred (11 generic + 18 single-target + 6 secret + 6 service-account across the full 22-family matrix)'
        # B's tasks-queues-list fixture returns exactly one queue.
        Assert-That -Condition ($null -ne $bReport -and -not (@($bReport.warnings) -contains 'multiple candidate queues')) -Name 'B (Defect 4 / one queue) : no "multiple candidate queues" warning is produced for exactly one queue'
    }

    # ====================================================================
    # Scenario C: blocker scenario (project lifecycle state not ACTIVE)
    # ====================================================================
    $cFixtures = @{
        'version'                       = New-FixtureEnvelope -StdoutObject @{ 'Google Cloud SDK' = '999.0.0' }
        'auth-list'                     = New-FixtureEnvelope -StdoutObject (New-CleanAuthListStdout)
        'config-list'                   = New-FixtureEnvelope -StdoutObject (New-CleanConfigListStdout)
        'projects-describe--synthetic-project-a' = New-FixtureEnvelope -StdoutObject @{ projectId = $aProjectId; lifecycleState = 'DELETE_REQUESTED'; projectNumber = $script:ProjectNumber }
        'projects-get-iam-policy--synthetic-project-a' = New-FixtureEnvelope -StdoutObject (New-EmptyIamPolicyStdout)
        'services-list'                 = New-FixtureEnvelope -StdoutObject (New-CleanEnabledServicesStdout)
        'artifacts-repositories-list'    = New-FixtureEnvelope -StdoutObject @(@{ name = 'synthetic-repo'; format = 'DOCKER' })
        'run-services-list'              = New-FixtureEnvelope -StdoutObject @()
        'iam-service-accounts-list'      = New-FixtureEnvelope -StdoutObject @()
        'secrets-list'                   = New-FixtureEnvelope -StdoutObject @()
        'tasks-queues-list'              = New-FixtureEnvelope -StdoutObject @()
    }
    $cResult = Invoke-Scenario -Name 'C-blocker-project-lifecycle' -Fixtures $cFixtures -CliParams @{
        ProjectId     = $aProjectId
        Region        = $aRegion
        TasksLocation = $aTasksLocation
    }

    if ($cResult) {
        Assert-That -Condition ($cResult.ExitCode -eq 2) -Name 'C : exit code is 2 (blocker present)'
        $cReport = Get-ParsedReport -Result $cResult
        $cHasExpectedBlocker = $false
        if ($cReport) {
            $cHasExpectedBlocker = @($cReport.blockers | Where-Object { $_ -like 'project lifecycle state not ACTIVE:*' }).Count -gt 0
        }
        Assert-That -Condition $cHasExpectedBlocker -Name 'C : report blockers contain the expected generic lifecycle-state blocker text'
        Assert-CommandContainment -Result $cResult -ScenarioName 'C'
    }

    # ====================================================================
    # Scenario D: local validation failure (exit code 3), gcloud never invoked
    # ====================================================================
    $dResult = Invoke-Scenario -Name 'D-local-validation-failure' -Fixtures @{} -CliParams @{
        ProjectId     = 'BadProjectId!'
        Region        = $aRegion
        TasksLocation = $aTasksLocation
    }

    if ($dResult) {
        Assert-That -Condition ($dResult.ExitCode -eq 3) -Name 'D : exit code is 3 (local validation failure, before any gcloud discovery)'
        Assert-That -Condition ($dResult.InvocationLog.Count -eq 0) -Name 'D : gcloud was never invoked when local validation fails'
        Assert-That -Condition (-not (Test-Path -LiteralPath $dResult.ReportPath -PathType Leaf)) -Name 'D : no report file was written'
    }

    # ====================================================================
    # Scenario E: local CLOUDSDK_AUTH_* authentication-override detection
    # ====================================================================
    $eSentinel = "SENTINEL-CRED-$([guid]::NewGuid().ToString('N'))"
    $eResult = Invoke-Scenario -Name 'E-cloudsdk-auth-override' -Fixtures $aFixtures -CliParams @{
        ProjectId     = $aProjectId
        Region        = $aRegion
        TasksLocation = $aTasksLocation
    } -ExtraEnv @{ 'CloudSdk_Auth_Impersonate_Service_Account' = $eSentinel }

    if ($eResult) {
        Assert-That -Condition ($eResult.ExitCode -eq 2) -Name 'E : exit code is 2 (authentication-override blocker)'
        $eReport = Get-ParsedReport -Result $eResult
        $eHasExpectedBlocker = $false
        if ($eReport) {
            $eHasExpectedBlocker = (@($eReport.blockers) -contains 'local CLOUDSDK_AUTH_* environment variable override detected: gcloud authentication behavior cannot be verified to match the audited active account')
        }
        Assert-That -Condition $eHasExpectedBlocker -Name 'E : report blockers contain the exact CLOUDSDK_AUTH_* override blocker text'
        Assert-NoSentinelLeakage -Result $eResult -Sentinels @($eSentinel) -ScenarioName 'E'
        Assert-CommandContainment -Result $eResult -ScenarioName 'E'
    }

    # ====================================================================
    # Scenario F: structurally malformed IAM policy is never silently
    # treated as clean/empty
    # ====================================================================
    $fSentinel = "SENTINEL-MALFORMED-$([guid]::NewGuid().ToString('N'))"
    $fFixtures = $aFixtures.Clone()
    $fFixtures['projects-get-iam-policy--synthetic-project-a'] = New-FixtureEnvelope -StdoutObject (
        [ordered]@{
            bindings = @(
                [ordered]@{ role = 123; members = @('serviceAccount:x@synthetic-project-a.iam.gserviceaccount.com'); rawNote = $fSentinel }
            )
        }
    )
    $fResult = Invoke-Scenario -Name 'F-malformed-iam-policy' -Fixtures $fFixtures -CliParams @{
        ProjectId     = $aProjectId
        Region        = $aRegion
        TasksLocation = $aTasksLocation
    }

    if ($fResult) {
        Assert-That -Condition ($fResult.ExitCode -ne 0) -Name 'F : malformed IAM policy never yields a clean (exit 0) readiness result'
        $fReport = Get-ParsedReport -Result $fResult
        $fHasExpectedBlocker = $false
        if ($fReport) {
            $fHasExpectedBlocker = (@($fReport.blockers) -contains 'generic discovery incomplete: projectIamPolicy (status: failed)')
        }
        Assert-That -Condition $fHasExpectedBlocker -Name 'F : report blockers contain the expected malformed-projectIamPolicy discovery-incomplete text'
        Assert-NoSentinelLeakage -Result $fResult -Sentinels @($fSentinel) -ScenarioName 'F'
        Assert-CommandContainment -Result $fResult -ScenarioName 'F'
    }

    # ====================================================================
    # Scenario G: conditional IAM bindings never satisfy proof and always
    # produce the human-review warning, with zero/one/multiple matching
    # bindings — the exact scalar-vs-array pipeline site fixed previously.
    # ====================================================================
    $expectedConditionalWarning = 'conditional IAM binding present for the task-caller Cloud Run invocation role; requires separate human review'
    $expectedMissingBindingBlocker = 'task-caller service account lacks an explicit Cloud Run invocation binding'

    # G-zero: no run.invoker/servicesInvoker binding for the caller anywhere.
    $gZeroFixtures = New-BScenarioFixtures
    $gZeroFixtures["run-services-get-iam-policy--$bWorkerServiceName"] = New-FixtureEnvelope -StdoutObject (New-EmptyIamPolicyStdout)
    $gZeroResult = Invoke-Scenario -Name 'G-zero-no-caller-binding' -Fixtures $gZeroFixtures -CliParams $bCliParams

    if ($gZeroResult) {
        Assert-That -Condition ($gZeroResult.ExitCode -ne 4) -Name 'G-zero : no unhandled-exception exit code (4) occurs with zero matching bindings'
        $gZeroReport = Get-ParsedReport -Result $gZeroResult
        $gZeroHasMissingBlocker = $false
        $gZeroHasWarning = $true
        if ($gZeroReport) {
            $gZeroHasMissingBlocker = (@($gZeroReport.blockers) -contains $expectedMissingBindingBlocker)
            $gZeroHasWarning = (@($gZeroReport.warnings) -contains $expectedConditionalWarning)
        }
        Assert-That -Condition $gZeroHasMissingBlocker -Name 'G-zero : missing-invocation-binding blocker is present'
        Assert-That -Condition (-not $gZeroHasWarning) -Name 'G-zero : conditional-binding human-review warning is absent (no conditional binding exists)'
    }

    # G-one: exactly one matching binding, and it is conditional (scalar
    # Where-Object result — the exact case the prior pipeline-concatenation
    # fix addressed).
    $gOneSentinel = "SENTINEL-COND-$([guid]::NewGuid().ToString('N'))"
    $gOneFixtures = New-BScenarioFixtures
    $gOneFixtures["run-services-get-iam-policy--$bWorkerServiceName"] = New-FixtureEnvelope -StdoutObject (
        [ordered]@{
            bindings = @(
                [ordered]@{
                    role      = 'roles/run.invoker'
                    members   = @("serviceAccount:$bCallerSa")
                    condition = [ordered]@{ expression = "$gOneSentinel-EXPR"; title = "$gOneSentinel-TITLE"; description = "$gOneSentinel-DESC" }
                }
            )
        }
    )
    $gOneResult = Invoke-Scenario -Name 'G-one-conditional-caller-binding' -Fixtures $gOneFixtures -CliParams $bCliParams

    if ($gOneResult) {
        Assert-That -Condition ($gOneResult.ExitCode -ne 4) -Name 'G-one : no unhandled-exception exit code (4) occurs with exactly one (scalar) matching binding'
        $gOneReport = Get-ParsedReport -Result $gOneResult
        $gOneHasMissingBlocker = $false
        $gOneHasWarning = $false
        if ($gOneReport) {
            $gOneHasMissingBlocker = (@($gOneReport.blockers) -contains $expectedMissingBindingBlocker)
            $gOneHasWarning = (@($gOneReport.warnings) -contains $expectedConditionalWarning)
        }
        Assert-That -Condition $gOneHasMissingBlocker -Name 'G-one : missing-invocation-binding blocker is present (conditional binding never counts as proof)'
        Assert-That -Condition $gOneHasWarning -Name 'G-one : conditional-binding human-review warning is present with exact expected text'
        Assert-NoSentinelLeakage -Result $gOneResult -Sentinels @("$gOneSentinel-EXPR", "$gOneSentinel-TITLE", "$gOneSentinel-DESC") -ScenarioName 'G-one'
    }

    # G-multiple: two distinct conditional bindings across both accepted
    # invocation roles, at both project and service scope.
    $gMultiSentinel = "SENTINEL-COND-MULTI-$([guid]::NewGuid().ToString('N'))"
    $gMultiFixtures = New-BScenarioFixtures
    $gMultiFixtures["run-services-get-iam-policy--$bWorkerServiceName"] = New-FixtureEnvelope -StdoutObject (
        [ordered]@{
            bindings = @(
                [ordered]@{
                    role      = 'roles/run.invoker'
                    members   = @("serviceAccount:$bCallerSa")
                    condition = [ordered]@{ expression = "$gMultiSentinel-A-EXPR"; title = "$gMultiSentinel-A-TITLE"; description = "$gMultiSentinel-A-DESC" }
                }
                [ordered]@{
                    role      = 'roles/run.servicesInvoker'
                    members   = @("serviceAccount:$bCallerSa")
                    condition = [ordered]@{ expression = "$gMultiSentinel-B-EXPR"; title = "$gMultiSentinel-B-TITLE"; description = "$gMultiSentinel-B-DESC" }
                }
            )
        }
    )
    $gMultiFixtures["projects-get-iam-policy--$bProjectId"] = New-FixtureEnvelope -StdoutObject (
        [ordered]@{
            bindings = @(
                [ordered]@{ role = 'roles/cloudtasks.serviceAgent'; members = @($bCloudTasksAgentMember) }
                [ordered]@{
                    role      = 'roles/run.invoker'
                    members   = @("serviceAccount:$bCallerSa")
                    condition = [ordered]@{ expression = "$gMultiSentinel-C-EXPR"; title = "$gMultiSentinel-C-TITLE"; description = "$gMultiSentinel-C-DESC" }
                }
            )
        }
    )
    $gMultiResult = Invoke-Scenario -Name 'G-multiple-conditional-caller-bindings' -Fixtures $gMultiFixtures -CliParams $bCliParams

    if ($gMultiResult) {
        Assert-That -Condition ($gMultiResult.ExitCode -ne 4) -Name 'G-multiple : no unhandled-exception exit code (4) occurs with multiple (array) matching bindings across two scopes'
        $gMultiReport = Get-ParsedReport -Result $gMultiResult
        $gMultiHasMissingBlocker = $false
        $gMultiHasWarning = $false
        if ($gMultiReport) {
            $gMultiHasMissingBlocker = (@($gMultiReport.blockers) -contains $expectedMissingBindingBlocker)
            $gMultiHasWarning = (@($gMultiReport.warnings) -contains $expectedConditionalWarning)
        }
        Assert-That -Condition $gMultiHasMissingBlocker -Name 'G-multiple : missing-invocation-binding blocker is present (three conditional bindings still never count as proof)'
        Assert-That -Condition $gMultiHasWarning -Name 'G-multiple : conditional-binding human-review warning is present exactly once with expected text'
        Assert-NoSentinelLeakage -Result $gMultiResult -Sentinels @(
            "$gMultiSentinel-A-EXPR", "$gMultiSentinel-A-TITLE", "$gMultiSentinel-A-DESC",
            "$gMultiSentinel-B-EXPR", "$gMultiSentinel-B-TITLE", "$gMultiSentinel-B-DESC",
            "$gMultiSentinel-C-EXPR", "$gMultiSentinel-C-TITLE", "$gMultiSentinel-C-DESC"
        ) -ScenarioName 'G-multiple'
    }

    # ====================================================================
    # Scenario Q: Cloud Tasks queues warning with two-or-more queues
    # (Defect 4 full end-to-end reproduction/regression). tasks-queues-list
    # is one of the 11 unconditional generic-discovery commands — it does
    # not require -QueueName — so this reuses the required-discovery-only
    # fixture set (scenario A's) with only the tasks-queues-list fixture
    # overridden to return two queue objects instead of zero. Before the
    # Defect 4 correction, this exact shape (a successful, non-empty
    # taskQueuesResult.data captured via the bare, unwrapped
    # `$queues = ConvertTo-DataArray ...` assignment) was never actually the
    # failure trigger — the $null-collapse only manifested for zero queues —
    # but this scenario proves the corrected `@(...)`-wrapped assignment
    # still correctly counts two real queue objects and produces exactly
    # one "multiple candidate queues" warning through the real, full,
    # end-to-end preflight run (not a rewritten copy of the logic).
    # ====================================================================
    $qFixtures = $aFixtures.Clone()
    $qFixtures['tasks-queues-list'] = New-FixtureEnvelope -StdoutObject @(
        @{ name = 'synthetic-queue-one'; state = 'PAUSED' },
        @{ name = 'synthetic-queue-two'; state = 'PAUSED' }
    )
    $qResult = Invoke-Scenario -Name 'Q-multiple-queues-warning' -Fixtures $qFixtures -CliParams @{
        ProjectId     = $aProjectId
        Region        = $aRegion
        TasksLocation = $aTasksLocation
    }

    if ($qResult) {
        Assert-That -Condition ($qResult.ExitCode -eq 0) -Name 'Q (Defect 4 / two queues) : exit code is 0 (multiple queues is a warning, never a blocker)'
        $qReport = Get-ParsedReport -Result $qResult
        Assert-That -Condition ($null -ne $qReport -and @($qReport.blockers).Count -eq 0) -Name 'Q (Defect 4 / two queues) : report contains zero blockers'
        $qWarningCount = 0
        if ($qReport) {
            $qWarningCount = @($qReport.warnings | Where-Object { $_ -ceq 'multiple candidate queues' }).Count
        }
        Assert-That -Condition ($qWarningCount -eq 1) -Name 'Q (Defect 4 / two queues) : exactly one "multiple candidate queues" warning is present'
        Assert-CommandContainment -Result $qResult -ScenarioName 'Q'
    }

    # ====================================================================
    # Empty-collection regression: proves the AllowEmptyCollection
    # correction on $Blockers in both Add-GenericDiscoveryBlocker and
    # Add-TargetVerificationBlockers, directly against the real,
    # dot-sourced production functions in an isolated child PowerShell
    # process (so it never contaminates this harness's own session),
    # independent of the gcloud sandbox. Previously (before the
    # correction), the very first call to Add-GenericDiscoveryBlocker in
    # Invoke-PrivateWorkerPreflightMain threw
    # "Cannot bind argument to parameter 'Blockers' because it is an empty
    # collection." on every invocation, clean or not, because $blockers
    # starts genuinely empty and PowerShell's mandatory-parameter binding
    # rejects an empty collection without AllowEmptyCollection.
    # ====================================================================
    Write-ScenarioHeader -Name 'Empty-collection-regression'

    $regressionProbeContent = @'
param([string] $ProductionScriptPath)
. $ProductionScriptPath

$results = [ordered]@{}

try {
    $blockersA = New-Object System.Collections.Generic.List[string]
    Add-GenericDiscoveryBlocker -Result ([pscustomobject]@{ status = 'success' }) -Label 'gcloudVersion' -Blockers $blockersA
    $results.genericAcceptsEmptyList = $true
    $results.genericSuccessLeavesEmpty = ($blockersA.Count -eq 0)
}
catch {
    $results.genericAcceptsEmptyList = $false
    $results.genericSuccessLeavesEmpty = $false
}

try {
    $blockersB = New-Object System.Collections.Generic.List[string]
    Add-GenericDiscoveryBlocker -Result ([pscustomobject]@{ status = 'failed' }) -Label 'gcloudVersion' -Blockers $blockersB
    $results.genericFailedAddsBlocker = (@($blockersB).Count -eq 1 -and $blockersB[0] -ceq 'generic discovery incomplete: gcloudVersion (status: failed)')
}
catch {
    $results.genericFailedAddsBlocker = $false
}

try {
    $blockersC = New-Object System.Collections.Generic.List[string]
    $successResults = [ordered]@{ workerServiceDescribe = [pscustomobject]@{ status = 'success' } }
    Add-TargetVerificationBlockers -Label 'WorkerServiceName' -Blockers $blockersC -Results $successResults
    $results.targetAcceptsEmptyList = $true
    $results.targetSuccessLeavesEmpty = ($blockersC.Count -eq 0)
}
catch {
    $results.targetAcceptsEmptyList = $false
    $results.targetSuccessLeavesEmpty = $false
}

try {
    $blockersD = New-Object System.Collections.Generic.List[string]
    $notFoundResults = [ordered]@{ workerServiceDescribe = [pscustomobject]@{ status = 'not_found' } }
    Add-TargetVerificationBlockers -Label 'WorkerServiceName' -Blockers $blockersD -Results $notFoundResults
    $results.targetNotFoundAddsBlocker = (@($blockersD).Count -eq 1 -and $blockersD[0] -ceq 'missing supplied target resource: WorkerServiceName')
}
catch {
    $results.targetNotFoundAddsBlocker = $false
}

$results | ConvertTo-Json -Compress
'@
    $regressionProbePath = Join-Path -Path $script:Sandbox.Root -ChildPath 'empty-collection-regression-probe.ps1'
    Set-Content -LiteralPath $regressionProbePath -Value $regressionProbeContent -Encoding UTF8

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $regressionProbeOutput = ''
    try {
        $regressionProbeLines = & 'powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $regressionProbePath -ProductionScriptPath $script:ProductionScriptPath 2>$null
        $regressionProbeOutput = ($regressionProbeLines -join "`n")
    }
    catch {
        $regressionProbeOutput = ''
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    $regressionResults = $null
    try {
        $regressionResults = $regressionProbeOutput | ConvertFrom-Json
    }
    catch {
        $regressionResults = $null
    }

    $probeRanCleanly = ($null -ne $regressionResults)
    Assert-That -Condition $probeRanCleanly -Name 'Empty-collection regression probe produced parseable structured output'

    Assert-That -Condition ($probeRanCleanly -and $regressionResults.genericAcceptsEmptyList -eq $true) -Name 'REGRESSION 1: Add-GenericDiscoveryBlocker accepts a genuinely empty List[string] $Blockers without a parameter-binding exception'
    Assert-That -Condition ($probeRanCleanly -and $regressionResults.genericSuccessLeavesEmpty -eq $true) -Name 'REGRESSION 2: a success result leaves the (previously-empty) list empty'
    Assert-That -Condition ($probeRanCleanly -and $regressionResults.genericFailedAddsBlocker -eq $true) -Name 'REGRESSION 3: a failed result adds the expected generic-discovery blocker text'
    Assert-That -Condition ($probeRanCleanly -and $regressionResults.targetAcceptsEmptyList -eq $true) -Name 'REGRESSION 4: Add-TargetVerificationBlockers accepts a genuinely empty List[string] $Blockers without a parameter-binding exception'
    Assert-That -Condition ($probeRanCleanly -and $regressionResults.targetSuccessLeavesEmpty -eq $true) -Name 'REGRESSION 5: a successful target result leaves the list empty'
    Assert-That -Condition ($probeRanCleanly -and $regressionResults.targetNotFoundAddsBlocker -eq $true) -Name 'REGRESSION 6: a not_found target result adds the existing expected "missing supplied target resource" blocker'

    # ====================================================================
    # Get-SafeProperty regression: proves the .PSObject.Properties
    # correction directly against the real, dot-sourced production
    # function in an isolated child PowerShell process, independent of
    # the gcloud sandbox. Previously, Get-SafeProperty's use of
    # [System.Management.Automation.PSObject]::AsPSObject($current)
    # returned the *same* object reference unchanged on Windows
    # PowerShell 5.1 Desktop (the required execution platform) rather
    # than a distinct PSObject wrapper, and a bare .Properties access on
    # that reference threw under Set-StrictMode -Version Latest for
    # virtually any parsed ConvertFrom-Json value — every scenario above
    # that needed evaluation to progress past the first real property
    # read failed for this reason.
    # ====================================================================
    Write-ScenarioHeader -Name 'GetSafeProperty-regression'

    $gspProbeContent = @'
param([string] $ProductionScriptPath)
. $ProductionScriptPath

$results = [ordered]@{}

try {
    $p1 = '{"a":"b"}' | ConvertFrom-Json
    $r1 = Get-SafeProperty -Object $p1 -PropertyPath @('a')
    $results.normalReadCorrect = ($r1 -ceq 'b')
}
catch {
    $results.normalReadCorrect = $false
}

try {
    $p2 = '{"outer":{"inner":"value"}}' | ConvertFrom-Json
    $r2 = Get-SafeProperty -Object $p2 -PropertyPath @('outer', 'inner')
    $results.nestedReadCorrect = ($r2 -ceq 'value')
}
catch {
    $results.nestedReadCorrect = $false
}

try {
    $p3 = '{"a":"b"}' | ConvertFrom-Json
    $r3 = Get-SafeProperty -Object $p3 -PropertyPath @('zzz')
    $results.absentReturnsNull = ($null -eq $r3)
}
catch {
    $results.absentReturnsNull = $false
}

try {
    $p4 = '{"a":null}' | ConvertFrom-Json
    $r4 = Get-SafeProperty -Object $p4 -PropertyPath @('a')
    $results.explicitNullReturnsNull = ($null -eq $r4)
}
catch {
    $results.explicitNullReturnsNull = $false
}

try {
    $p5 = '{"a":"stringvalue"}' | ConvertFrom-Json
    $r5 = Get-SafeProperty -Object $p5 -PropertyPath @('a', 'nonexistent')
    $results.scalarIntermediateReturnsNull = ($null -eq $r5)
}
catch {
    $results.scalarIntermediateReturnsNull = $false
}

# A deliberately throwing property getter, constructed via Add-Member
# ScriptProperty (no compiler required). Verified, real Windows
# PowerShell 5.1 engine behavior: reading .PSObject.Properties[name].Value
# for a throwing getter does not propagate the exception — it silently
# returns $null (no exception, nothing recorded in $Error). This is the
# only accessor that avoids the primary defect above while staying within
# this round's constraints (no dynamic $current.$propertyName access, no
# Invoke-Expression, no JSON re-conversion, no enumerating all properties).
# It is inert for this script's real inputs: every object Get-SafeProperty
# is ever actually asked to read is ConvertFrom-Json output, whose members
# are always plain NoteProperty values that cannot throw on read.
$p6 = New-Object PSObject
Add-Member -InputObject $p6 -MemberType ScriptProperty -Name 'Boom' -Value { throw 'deliberate hostile getter (test-only)' }
$threw6 = $false
$value6 = 'unset'
try {
    $value6 = Get-SafeProperty -Object $p6 -PropertyPath @('Boom')
}
catch {
    $threw6 = $true
}
$results.throwingGetterThrew = $threw6
$results.throwingGetterValueIsNull = ($null -eq $value6)

$results | ConvertTo-Json -Compress
'@
    $gspProbePath = Join-Path -Path $script:Sandbox.Root -ChildPath 'get-safe-property-regression-probe.ps1'
    Set-Content -LiteralPath $gspProbePath -Value $gspProbeContent -Encoding UTF8

    $previousErrorActionPreference2 = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $gspProbeOutput = ''
    try {
        $gspProbeLines = & 'powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gspProbePath -ProductionScriptPath $script:ProductionScriptPath 2>$null
        $gspProbeOutput = ($gspProbeLines -join "`n")
    }
    catch {
        $gspProbeOutput = ''
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference2
    }

    $gspResults = $null
    try {
        $gspResults = $gspProbeOutput | ConvertFrom-Json
    }
    catch {
        $gspResults = $null
    }

    $gspProbeRanCleanly = ($null -ne $gspResults)
    Assert-That -Condition $gspProbeRanCleanly -Name 'Get-SafeProperty regression probe produced parseable structured output'

    Assert-That -Condition ($gspProbeRanCleanly -and $gspResults.normalReadCorrect -eq $true) -Name 'GSP-REGRESSION 1: a normal ConvertFrom-Json PSCustomObject property reads correctly ({"a":"b"} path a returns "b")'
    Assert-That -Condition ($gspProbeRanCleanly -and $gspResults.nestedReadCorrect -eq $true) -Name 'GSP-REGRESSION 2: a nested property path reads correctly ({"outer":{"inner":"value"}} path outer,inner returns "value")'
    Assert-That -Condition ($gspProbeRanCleanly -and $gspResults.absentReturnsNull -eq $true) -Name 'GSP-REGRESSION 3: an absent property returns null without throwing'
    Assert-That -Condition ($gspProbeRanCleanly -and $gspResults.explicitNullReturnsNull -eq $true) -Name 'GSP-REGRESSION 4: an explicitly null property returns null without throwing'
    Assert-That -Condition ($gspProbeRanCleanly -and $gspResults.scalarIntermediateReturnsNull -eq $true) -Name 'GSP-REGRESSION 5: a scalar intermediate value followed by a nonexistent nested property returns null without an unhandled exception'
    Assert-That -Condition ($gspProbeRanCleanly -and $gspResults.throwingGetterThrew -eq $false -and $gspResults.throwingGetterValueIsNull -eq $true) -Name 'GSP-REGRESSION 6 (documented Windows PowerShell 5.1 engine behavior, inert for real ConvertFrom-Json NoteProperty input): a throwing property getter returns $null via .PSObject.Properties[...].Value rather than propagating — see PRIVATE_WORKER_PREFLIGHT_RUNTIME_TESTS.md'

    # ====================================================================
    # Get-PropertyReadOutcome NoteProperty-only regression: proves the
    # third correction directly against the real, dot-sourced production
    # function in an isolated child PowerShell process, independent of
    # the gcloud sandbox. The prior AsPSObject/.Properties[...] pattern is
    # gone; Get-PropertyReadOutcome now looks up the member via the
    # intrinsic $Object.PSObject.Properties[$PropertyName] view (a lookup
    # that never invokes a getter) and reads .Value only when that member
    # is a NoteProperty — a plain stored value with no getter code to
    # run. Any other member type (ScriptProperty, adapted CLR Property,
    # etc.) is rejected as AccessFailed=$true before it is ever invoked.
    # Scenarios E and F prove that rejection happens WITHOUT invoking the
    # hostile getter at all, using a separate counter the getter itself
    # would increment if it ever ran.
    # ====================================================================
    Write-ScenarioHeader -Name 'GetPropertyReadOutcome-NotePropertyOnly-regression'

    $gproProbeContent = @'
param([string] $ProductionScriptPath)
. $ProductionScriptPath

$results = [ordered]@{}

# A. Ordinary present property on a plain [pscustomobject] (NoteProperty).
try {
    $pA = [pscustomobject]@{ a = 'b' }
    $oA = Get-PropertyReadOutcome -Object $pA -PropertyName 'a'
    $results.A_Found = $oA.Found
    $results.A_Value = $oA.Value
    $results.A_AccessFailed = $oA.AccessFailed
}
catch {
    $results.A_Found = $null; $results.A_Value = $null; $results.A_AccessFailed = $null
}

# B. Present property on real ConvertFrom-Json output (NoteProperty).
try {
    $pB = '{"a":"b"}' | ConvertFrom-Json
    $oB = Get-PropertyReadOutcome -Object $pB -PropertyName 'a'
    $results.B_Found = $oB.Found
    $results.B_Value = $oB.Value
    $results.B_AccessFailed = $oB.AccessFailed
}
catch {
    $results.B_Found = $null; $results.B_Value = $null; $results.B_AccessFailed = $null
}

# C. Missing property.
try {
    $pC = [pscustomobject]@{ a = 'b' }
    $oC = Get-PropertyReadOutcome -Object $pC -PropertyName 'zzz'
    $results.C_Found = $oC.Found
    $results.C_Value = $oC.Value
    $results.C_AccessFailed = $oC.AccessFailed
}
catch {
    $results.C_Found = $null; $results.C_Value = $null; $results.C_AccessFailed = $null
}

# D. Explicitly null NoteProperty.
try {
    $pD = [pscustomobject]@{ a = $null }
    $oD = Get-PropertyReadOutcome -Object $pD -PropertyName 'a'
    $results.D_Found = $oD.Found
    $results.D_Value = $oD.Value
    $results.D_AccessFailed = $oD.AccessFailed
}
catch {
    $results.D_Found = $null; $results.D_Value = $null; $results.D_AccessFailed = $null
}

# E. Throwing ScriptProperty getter — must be rejected by MemberType
# WITHOUT ever being invoked. $script:eGetterInvocationCount proves this:
# it can only become nonzero if the getter itself actually ran.
$script:eGetterInvocationCount = 0
$pE = [pscustomobject]@{ a = 1 }
Add-Member -InputObject $pE -MemberType ScriptProperty -Name 'boom' -Value { $script:eGetterInvocationCount++; throw 'deliberate hostile ScriptProperty getter (test-only)' } -Force
try {
    $oE = Get-PropertyReadOutcome -Object $pE -PropertyName 'boom'
    $results.E_Found = $oE.Found
    $results.E_Value = $oE.Value
    $results.E_AccessFailed = $oE.AccessFailed
}
catch {
    $results.E_Found = $null; $results.E_Value = $null; $results.E_AccessFailed = $null
}
$results.E_GetterInvocationCount = $script:eGetterInvocationCount

# F. Throwing compiled CLR property getter — must be rejected by
# MemberType WITHOUT ever being invoked. [RuntimeThrowingClrType]::GetCount
# is a static counter only the getter itself can increment.
Add-Type -TypeDefinition @"
using System;
public class RuntimeThrowingClrType {
    public static int GetCount = 0;
    public string Boom { get { RuntimeThrowingClrType.GetCount++; throw new InvalidOperationException("deliberate hostile CLR getter (test-only)"); } }
}
"@
$pF = New-Object RuntimeThrowingClrType
try {
    $oF = Get-PropertyReadOutcome -Object $pF -PropertyName 'Boom'
    $results.F_Found = $oF.Found
    $results.F_Value = $oF.Value
    $results.F_AccessFailed = $oF.AccessFailed
}
catch {
    $results.F_Found = $null; $results.F_Value = $null; $results.F_AccessFailed = $null
}
$results.F_GetterInvocationCount = [RuntimeThrowingClrType]::GetCount

# G. ConvertTo-SafeGcloudConfigListResult accepts pristine, structurally
# valid config data and produces the expected normalized booleans/account.
try {
    $configData = '{"core":{"account":"synthetic-user@example.invalid"},"auth":{}}' | ConvertFrom-Json
    $fakeConfigResult = [pscustomobject]@{ id = 'configList'; status = 'success'; exitCode = 0; data = $configData }
    $safeConfig = ConvertTo-SafeGcloudConfigListResult -Result $fakeConfigResult
    $results.G_Status = $safeConfig.status
    $results.G_Account = $safeConfig.data.coreAccount
    $results.G_ImpersonateConfigured = $safeConfig.data.impersonateServiceAccountConfigured
    $results.G_AccessTokenFileConfigured = $safeConfig.data.accessTokenFileConfigured
    $results.G_CredentialFileOverrideConfigured = $safeConfig.data.credentialFileOverrideConfigured
    $results.G_DisableCredentialsEnabled = $safeConfig.data.disableCredentialsEnabled
}
catch {
    $results.G_Status = $null
}

# H. Test-IsUnconditionalBinding: absent / explicit-null / present-non-null
# / throwing-getter-named-condition (which must also never be invoked).
try {
    $hAbsent = [pscustomobject]@{ role = 'x'; members = @('y') }
    $results.H_AbsentIsUnconditional = (Test-IsUnconditionalBinding -Binding $hAbsent)
}
catch {
    $results.H_AbsentIsUnconditional = $null
}

try {
    $hNull = [pscustomobject]@{ role = 'x'; members = @('y'); condition = $null }
    $results.H_NullIsUnconditional = (Test-IsUnconditionalBinding -Binding $hNull)
}
catch {
    $results.H_NullIsUnconditional = $null
}

try {
    $hPresent = [pscustomobject]@{ role = 'x'; members = @('y'); condition = [pscustomobject]@{ present = $true } }
    $results.H_PresentIsUnconditional = (Test-IsUnconditionalBinding -Binding $hPresent)
}
catch {
    $results.H_PresentIsUnconditional = $null
}

$script:hGetterInvocationCount = 0
$hThrowing = [pscustomobject]@{ role = 'x'; members = @('y') }
Add-Member -InputObject $hThrowing -MemberType ScriptProperty -Name 'condition' -Value { $script:hGetterInvocationCount++; throw 'deliberate hostile condition getter (test-only)' } -Force
try {
    $results.H_ThrowingConditionIsUnconditional = (Test-IsUnconditionalBinding -Binding $hThrowing)
}
catch {
    $results.H_ThrowingConditionIsUnconditional = $null
}
$results.H_ThrowingConditionGetterInvocationCount = $script:hGetterInvocationCount

$results | ConvertTo-Json -Compress
'@
    $gproProbePath = Join-Path -Path $script:Sandbox.Root -ChildPath 'get-property-read-outcome-regression-probe.ps1'
    Set-Content -LiteralPath $gproProbePath -Value $gproProbeContent -Encoding UTF8

    $previousErrorActionPreference3 = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $gproProbeOutput = ''
    try {
        $gproProbeLines = & 'powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gproProbePath -ProductionScriptPath $script:ProductionScriptPath 2>$null
        $gproProbeOutput = ($gproProbeLines -join "`n")
    }
    catch {
        $gproProbeOutput = ''
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference3
    }

    $gproResults = $null
    try {
        $gproResults = $gproProbeOutput | ConvertFrom-Json
    }
    catch {
        $gproResults = $null
    }

    $gproProbeRanCleanly = ($null -ne $gproResults)
    Assert-That -Condition $gproProbeRanCleanly -Name 'Get-PropertyReadOutcome NoteProperty-only regression probe produced parseable structured output'

    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.A_Found -eq $true -and $gproResults.A_Value -ceq 'b' -and $gproResults.A_AccessFailed -eq $false) -Name 'GPRO-A: ordinary present NoteProperty on a plain pscustomobject returns Found=true, Value=''b'', AccessFailed=false'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.B_Found -eq $true -and $gproResults.B_Value -ceq 'b' -and $gproResults.B_AccessFailed -eq $false) -Name 'GPRO-B: present property on real ConvertFrom-Json output returns Found=true with the expected value'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.C_Found -eq $false -and $null -eq $gproResults.C_Value -and $gproResults.C_AccessFailed -eq $false) -Name 'GPRO-C: missing property returns Found=false, Value=null, AccessFailed=false'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.D_Found -eq $true -and $null -eq $gproResults.D_Value -and $gproResults.D_AccessFailed -eq $false) -Name 'GPRO-D: explicitly null NoteProperty returns Found=true, Value=null, AccessFailed=false'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.E_Found -eq $false -and $null -eq $gproResults.E_Value -and $gproResults.E_AccessFailed -eq $true) -Name 'GPRO-E: throwing ScriptProperty getter returns Found=false, Value=null, AccessFailed=true'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.E_GetterInvocationCount -eq 0) -Name 'GPRO-E: the throwing ScriptProperty getter was never invoked (invocation counter stayed 0)'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.F_Found -eq $false -and $null -eq $gproResults.F_Value -and $gproResults.F_AccessFailed -eq $true) -Name 'GPRO-F: throwing compiled CLR property getter returns Found=false, Value=null, AccessFailed=true'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.F_GetterInvocationCount -eq 0) -Name 'GPRO-F: the throwing CLR property getter was never invoked (static counter stayed 0)'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.G_Status -eq 'success') -Name 'GPRO-G: ConvertTo-SafeGcloudConfigListResult accepts pristine, structurally valid config data (status remains success)'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.G_Account -ceq $script:ActiveAccount) -Name 'GPRO-G: the normalized coreAccount matches the pristine config data'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.G_ImpersonateConfigured -eq $false -and $gproResults.G_AccessTokenFileConfigured -eq $false -and $gproResults.G_CredentialFileOverrideConfigured -eq $false -and $gproResults.G_DisableCredentialsEnabled -eq $false) -Name 'GPRO-G: all four auth-override/disable-credentials booleans normalize to false for an empty auth section'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.H_AbsentIsUnconditional -eq $true) -Name 'GPRO-H: Test-IsUnconditionalBinding returns true when condition is absent'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.H_NullIsUnconditional -eq $true) -Name 'GPRO-H: Test-IsUnconditionalBinding returns true when condition is explicitly null'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.H_PresentIsUnconditional -eq $false) -Name 'GPRO-H: Test-IsUnconditionalBinding returns false for a present non-null condition NoteProperty'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.H_ThrowingConditionIsUnconditional -eq $false) -Name 'GPRO-H: Test-IsUnconditionalBinding returns false (fails closed) for a ScriptProperty-typed condition, without invoking its getter'
    Assert-That -Condition ($gproProbeRanCleanly -and $gproResults.H_ThrowingConditionGetterInvocationCount -eq 0) -Name 'GPRO-H: the throwing condition ScriptProperty getter was never invoked by Test-IsUnconditionalBinding (invocation counter stayed 0)'

    # ====================================================================
    # Cloud Tasks queues empty-array pipeline-unrolling regression
    # (Defect 4): proves the exact normalized expression now used at the
    # queues call site — @(ConvertTo-DataArray $Data) — against the real,
    # dot-sourced ConvertTo-DataArray, for null, an empty-JSON-array-after-
    # ConvertFrom-Json, a single queue object, and two queue objects. This
    # is independent of, and in addition to, scenarios A, B, and Q above,
    # which exercise the corrected line inside the real, full, end-to-end
    # preflight run rather than a rewritten copy of the logic.
    # ====================================================================
    Write-ScenarioHeader -Name 'CloudTasksQueues-EmptyArrayPipelineUnrolling-regression (Defect 4)'

    $queuesProbeContent = @'
param([string] $ProductionScriptPath)
. $ProductionScriptPath

$results = [ordered]@{}

# A. Null input.
try {
    $rA = @(ConvertTo-DataArray $null)
    $results.A_Count = $rA.Count
    $results.A_IsArray = ($rA -is [array])
}
catch {
    $results.A_Count = $null; $results.A_IsArray = $null
}

# B. An empty JSON array, after Windows PowerShell 5.1's own
# ConvertFrom-Json normalization (which itself collapses "[]" to $null —
# a second, compounding quirk on top of the pipeline-unrolling one).
try {
    $emptyFromJson = '[]' | ConvertFrom-Json
    $rB = @(ConvertTo-DataArray $emptyFromJson)
    $results.B_Count = $rB.Count
    $results.B_IsArray = ($rB -is [array])
}
catch {
    $results.B_Count = $null; $results.B_IsArray = $null
}

# C. One queue object. ConvertFrom-Json on a single-element JSON array
# returns the bare object itself, not a one-element array — exactly the
# other shape ConvertTo-DataArray exists to normalize.
try {
    $oneQueue = '[{"name":"q1","state":"PAUSED"}]' | ConvertFrom-Json
    $rC = @(ConvertTo-DataArray $oneQueue)
    $results.C_Count = $rC.Count
}
catch {
    $results.C_Count = $null
}

# D. Two queue objects.
try {
    $twoQueues = '[{"name":"q1","state":"PAUSED"},{"name":"q2","state":"PAUSED"}]' | ConvertFrom-Json
    $rD = @(ConvertTo-DataArray $twoQueues)
    $results.D_Count = $rD.Count
}
catch {
    $results.D_Count = $null
}

# Also directly demonstrate the defect the correction closes: the OLD bare
# (unwrapped) assignment pattern collapses to $null for empty input, while
# the NEW @(...)-wrapped pattern does not.
try {
    $oldPatternResult = ConvertTo-DataArray $null
    $results.OldPatternIsNull = ($null -eq $oldPatternResult)
}
catch {
    $results.OldPatternIsNull = $null
}
try {
    $newPatternResult = @(ConvertTo-DataArray $null)
    $results.NewPatternIsNull = ($null -eq $newPatternResult)
}
catch {
    $results.NewPatternIsNull = $null
}

$results | ConvertTo-Json -Compress
'@
    $queuesProbePath = Join-Path -Path $script:Sandbox.Root -ChildPath 'cloud-tasks-queues-regression-probe.ps1'
    Set-Content -LiteralPath $queuesProbePath -Value $queuesProbeContent -Encoding UTF8

    $previousErrorActionPreference4 = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $queuesProbeOutput = ''
    try {
        $queuesProbeLines = & 'powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $queuesProbePath -ProductionScriptPath $script:ProductionScriptPath 2>$null
        $queuesProbeOutput = ($queuesProbeLines -join "`n")
    }
    catch {
        $queuesProbeOutput = ''
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference4
    }

    $queuesResults = $null
    try {
        $queuesResults = $queuesProbeOutput | ConvertFrom-Json
    }
    catch {
        $queuesResults = $null
    }

    $queuesProbeRanCleanly = ($null -ne $queuesResults)
    Assert-That -Condition $queuesProbeRanCleanly -Name 'Cloud Tasks queues regression probe produced parseable structured output'

    Assert-That -Condition ($queuesProbeRanCleanly -and $queuesResults.A_Count -eq 0 -and $queuesResults.A_IsArray -eq $true) -Name 'QUEUES-A: @(ConvertTo-DataArray $null) is a real array with Count = 0'
    Assert-That -Condition ($queuesProbeRanCleanly -and $queuesResults.B_Count -eq 0 -and $queuesResults.B_IsArray -eq $true) -Name 'QUEUES-B: an empty JSON array, after ConvertFrom-Json normalization, produces Count = 0 via the normalized expression'
    Assert-That -Condition ($queuesProbeRanCleanly -and $queuesResults.C_Count -eq 1) -Name 'QUEUES-C: one queue object produces Count = 1'
    Assert-That -Condition ($queuesProbeRanCleanly -and $queuesResults.D_Count -eq 2) -Name 'QUEUES-D: two queue objects produce Count = 2'
    Assert-That -Condition ($queuesProbeRanCleanly -and $queuesResults.OldPatternIsNull -eq $true) -Name 'QUEUES: the OLD bare (unwrapped) assignment pattern is confirmed to collapse to $null for empty input (the defect this correction closes)'
    Assert-That -Condition ($queuesProbeRanCleanly -and $queuesResults.NewPatternIsNull -eq $false) -Name 'QUEUES: the NEW @(...)-wrapped assignment pattern never collapses to $null, even for empty input'

    # ====================================================================
    # Get-SafeProperty array-identity regression (Defect 5): proves the
    # Write-Output -NoEnumerate correction directly against the real,
    # dot-sourced Get-SafeProperty in an isolated child process, independent
    # of the gcloud sandbox. A bare `return $current` writes $current to the
    # success output stream, and PowerShell enumerates array values placed
    # on the pipeline by default — a one-element array captured by a caller
    # into a plain scalar variable collapsed to its bare element, silently
    # losing the array's identity. This also proves the real IAM
    # normalization consequence: a binding with exactly one member (an
    # entirely realistic, common shape) previously failed the whole IAM
    # policy closed because its collapsed `members` scalar was rejected by
    # Test-IsScalarValue before ConvertTo-DataArray ever saw it.
    # ====================================================================
    Write-ScenarioHeader -Name 'GetSafeProperty-ArrayIdentity-regression (Defect 5)'

    $gspArrayProbeContent = @'
param([string] $ProductionScriptPath)
. $ProductionScriptPath

$results = [ordered]@{}

# A. Scalar property remains a scalar, not an array.
try {
    $pA = [pscustomobject]@{ value = 'one' }
    $rA = Get-SafeProperty -Object $pA -PropertyPath @('value')
    $results.A_IsArray = ($rA -is [array])
    $results.A_Value = $rA
}
catch {
    $results.A_IsArray = $null; $results.A_Value = $null
}

# B. Explicit-null property returns $null.
try {
    $pB = [pscustomobject]@{ value = $null }
    $rB = Get-SafeProperty -Object $pB -PropertyPath @('value')
    $results.B_IsNull = ($null -eq $rB)
}
catch {
    $results.B_IsNull = $null
}

# C. Empty-array property returns Object[] Count 0.
try {
    $pC = [pscustomobject]@{ value = @() }
    $rC = Get-SafeProperty -Object $pC -PropertyPath @('value')
    $results.C_IsNull = ($null -eq $rC)
    if ($null -ne $rC) {
        $results.C_IsArray = ($rC -is [array])
        $results.C_Count = $rC.Count
    }
}
catch {
    $results.C_IsNull = $null
}

# D. One-string array property returns Object[] Count 1, original string preserved.
try {
    $pD = [pscustomobject]@{ value = @('solo') }
    $rD = Get-SafeProperty -Object $pD -PropertyPath @('value')
    $results.D_IsArray = ($rD -is [array])
    $results.D_Count = $rD.Count
    $results.D_Value0 = $rD[0]
}
catch {
    $results.D_IsArray = $null
}

# E. Two-string array property returns Object[] Count 2, order preserved.
try {
    $pE = [pscustomobject]@{ value = @('first', 'second') }
    $rE = Get-SafeProperty -Object $pE -PropertyPath @('value')
    $results.E_IsArray = ($rE -is [array])
    $results.E_Count = $rE.Count
    $results.E_Value0 = $rE[0]
    $results.E_Value1 = $rE[1]
}
catch {
    $results.E_IsArray = $null
}

# F. One-object array property returns Object[] Count 1, original object fields preserved.
try {
    $pF = [pscustomobject]@{ value = @([pscustomobject]@{ role = 'r1'; member = 'm1' }) }
    $rF = Get-SafeProperty -Object $pF -PropertyPath @('value')
    $results.F_IsArray = ($rF -is [array])
    $results.F_Count = $rF.Count
    $results.F_Role0 = $rF[0].role
    $results.F_Member0 = $rF[0].member
}
catch {
    $results.F_IsArray = $null
}

# G. A nested path ending in a one-element array preserves that array.
try {
    $pG = [pscustomobject]@{ outer = [pscustomobject]@{ inner = @('nested-solo') } }
    $rG = Get-SafeProperty -Object $pG -PropertyPath @('outer', 'inner')
    $results.G_IsArray = ($rG -is [array])
    $results.G_Count = $rG.Count
    $results.G_Value0 = $rG[0]
}
catch {
    $results.G_IsArray = $null
}

# H. A missing property still returns $null.
try {
    $pH = [pscustomobject]@{ value = 'x' }
    $rH = Get-SafeProperty -Object $pH -PropertyPath @('nonexistent')
    $results.H_IsNull = ($null -eq $rH)
}
catch {
    $results.H_IsNull = $null
}

# IAM-1/2. ConvertTo-SafeIamPolicyResult accepts a policy with one binding
# carrying exactly one string member, and the normalized `members`
# property remains an array with Count 1.
try {
    $oneMemberPolicyData = '{"bindings":[{"role":"roles/run.invoker","members":["serviceAccount:one@example.invalid"]}]}' | ConvertFrom-Json
    $oneMemberResult = [pscustomobject]@{ id = 'testIamPolicy'; status = 'success'; exitCode = 0; data = $oneMemberPolicyData }
    $oneMemberSafe = ConvertTo-SafeIamPolicyResult -Result $oneMemberResult
    $results.IAM1_Status = $oneMemberSafe.status
    if ($oneMemberSafe.status -eq 'success') {
        $normalizedMembers = $oneMemberSafe.data.bindings[0].members
        $results.IAM2_MembersIsArray = ($normalizedMembers -is [array])
        $results.IAM2_MembersCount = @($normalizedMembers).Count
        $results.IAM2_Member0 = $normalizedMembers[0]
    }
}
catch {
    $results.IAM1_Status = $null
}

# IAM-3. A valid binding with multiple members still succeeds and preserves
# all members.
try {
    $multiMemberPolicyData = '{"bindings":[{"role":"roles/run.invoker","members":["serviceAccount:a@example.invalid","serviceAccount:b@example.invalid"]}]}' | ConvertFrom-Json
    $multiMemberResult = [pscustomobject]@{ id = 'testIamPolicy'; status = 'success'; exitCode = 0; data = $multiMemberPolicyData }
    $multiMemberSafe = ConvertTo-SafeIamPolicyResult -Result $multiMemberResult
    $results.IAM3_Status = $multiMemberSafe.status
    if ($multiMemberSafe.status -eq 'success') {
        $multiMembers = $multiMemberSafe.data.bindings[0].members
        $results.IAM3_MembersCount = @($multiMembers).Count
    }
}
catch {
    $results.IAM3_Status = $null
}

# IAM-4. A malformed scalar `members` value still fails closed.
try {
    $scalarMembersPolicyData = '{"bindings":[{"role":"roles/run.invoker","members":"not-an-array"}]}' | ConvertFrom-Json
    $scalarMembersResult = [pscustomobject]@{ id = 'testIamPolicy'; status = 'success'; exitCode = 0; data = $scalarMembersPolicyData }
    $scalarMembersSafe = ConvertTo-SafeIamPolicyResult -Result $scalarMembersResult
    $results.IAM4_Status = $scalarMembersSafe.status
}
catch {
    $results.IAM4_Status = $null
}

$results | ConvertTo-Json -Compress
'@
    $gspArrayProbePath = Join-Path -Path $script:Sandbox.Root -ChildPath 'get-safe-property-array-identity-regression-probe.ps1'
    Set-Content -LiteralPath $gspArrayProbePath -Value $gspArrayProbeContent -Encoding UTF8

    $previousErrorActionPreference5 = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $gspArrayProbeOutput = ''
    try {
        $gspArrayProbeLines = & 'powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gspArrayProbePath -ProductionScriptPath $script:ProductionScriptPath 2>$null
        $gspArrayProbeOutput = ($gspArrayProbeLines -join "`n")
    }
    catch {
        $gspArrayProbeOutput = ''
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference5
    }

    $gspArrayResults = $null
    try {
        $gspArrayResults = $gspArrayProbeOutput | ConvertFrom-Json
    }
    catch {
        $gspArrayResults = $null
    }

    $gspArrayProbeRanCleanly = ($null -ne $gspArrayResults)
    Assert-That -Condition $gspArrayProbeRanCleanly -Name 'Get-SafeProperty array-identity regression probe produced parseable structured output'

    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.A_IsArray -eq $false -and $gspArrayResults.A_Value -ceq 'one') -Name 'GSP-ARRAY-A: a scalar property remains a scalar string, not an array'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.B_IsNull -eq $true) -Name 'GSP-ARRAY-B: an explicit-null property returns $null'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.C_IsNull -eq $false -and $gspArrayResults.C_IsArray -eq $true -and $gspArrayResults.C_Count -eq 0) -Name 'GSP-ARRAY-C: an empty-array property returns a real array with Count 0'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.D_IsArray -eq $true -and $gspArrayResults.D_Count -eq 1 -and $gspArrayResults.D_Value0 -ceq 'solo') -Name 'GSP-ARRAY-D: a one-string array property returns Count 1 with the original string at index 0'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.E_IsArray -eq $true -and $gspArrayResults.E_Count -eq 2 -and $gspArrayResults.E_Value0 -ceq 'first' -and $gspArrayResults.E_Value1 -ceq 'second') -Name 'GSP-ARRAY-E: a two-string array property returns Count 2 with order preserved'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.F_IsArray -eq $true -and $gspArrayResults.F_Count -eq 1 -and $gspArrayResults.F_Role0 -ceq 'r1' -and $gspArrayResults.F_Member0 -ceq 'm1') -Name 'GSP-ARRAY-F: a one-object array property returns Count 1 with the original object fields preserved'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.G_IsArray -eq $true -and $gspArrayResults.G_Count -eq 1 -and $gspArrayResults.G_Value0 -ceq 'nested-solo') -Name 'GSP-ARRAY-G: a nested property path ending in a one-element array preserves that array'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.H_IsNull -eq $true) -Name 'GSP-ARRAY-H: a missing property still returns $null'

    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.IAM1_Status -eq 'success') -Name 'GSP-ARRAY-IAM-1: ConvertTo-SafeIamPolicyResult accepts a valid policy with one binding carrying exactly one string member'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.IAM2_MembersIsArray -eq $true -and $gspArrayResults.IAM2_MembersCount -eq 1 -and $gspArrayResults.IAM2_Member0 -ceq 'serviceAccount:one@example.invalid') -Name 'GSP-ARRAY-IAM-2: the normalized members property remains an array with Count 1 for a single-member binding'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.IAM3_Status -eq 'success' -and $gspArrayResults.IAM3_MembersCount -eq 2) -Name 'GSP-ARRAY-IAM-3: a valid binding with multiple members still succeeds and preserves all members'
    Assert-That -Condition ($gspArrayProbeRanCleanly -and $gspArrayResults.IAM4_Status -eq 'failed') -Name 'GSP-ARRAY-IAM-4: a malformed scalar members value still fails closed'

    # ====================================================================
    # Rogue ExternalScript gate regression: proves the corrected
    # Test-ChildResolvesToSyntheticGcloud gate examines the exact first
    # Application-or-ExternalScript candidate production would select —
    # not merely whether the synthetic Application appears anywhere in the
    # candidate list. An ExternalScript (e.g. a real Google Cloud SDK's own
    # gcloud.ps1, or a hostile script) placed earlier on PATH than the
    # synthetic sandbox executable must make the gate fail, and must never
    # be invoked merely by being inspected.
    # ====================================================================
    Write-ScenarioHeader -Name 'RogueExternalScript-GateRegression'

    $rogueRoot = $null
    try {
        # A. Confirm the normal sandbox arrangement passes first, as a
        # baseline, before introducing the rogue candidate.
        $env:PATH = "$($script:Sandbox.BinDir);$($script:OriginalPath)"
        $normalBaselinePasses = Test-ChildResolvesToSyntheticGcloud -ExpectedGcloudCmdPath $script:Sandbox.GcloudCmd
        Assert-That -Condition $normalBaselinePasses -Name 'ROGUE-A: the normal sandbox arrangement (synthetic gcloud.cmd first) passes the gate before any rogue candidate is introduced'

        # B. A unique rogue directory, entirely outside the repository —
        # the same absolute-safety check New-Sandbox itself performs.
        $rogueRoot = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("swingproai-rogue-gcloud-" + [guid]::NewGuid().ToString('N'))
        $canonicalRogueRoot = [System.IO.Path]::GetFullPath($rogueRoot)
        $canonicalRepoRootForRogue = [System.IO.Path]::GetFullPath($script:RepositoryRoot)
        $repoRootWithSeparatorForRogue = $canonicalRepoRootForRogue.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if ($canonicalRogueRoot.StartsWith($repoRootWithSeparatorForRogue, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to create the rogue directory inside the repository root.'
        }
        New-Item -ItemType Directory -Path $rogueRoot -Force | Out-Null

        # C/D. A test-only ExternalScript that, if ever actually executed,
        # creates a marker file — never a real gcloud invocation.
        $roguePs1Path = Join-Path -Path $rogueRoot -ChildPath 'gcloud.ps1'
        $markerPath = Join-Path -Path $rogueRoot -ChildPath 'executed.marker'
        $utf8NoBomRogue = New-Object System.Text.UTF8Encoding($false)
        $rogueScriptBody = "New-Item -ItemType File -Path '$markerPath' -Force | Out-Null`r`nexit 0`r`n"
        [System.IO.File]::WriteAllText($roguePs1Path, $rogueScriptBody, $utf8NoBomRogue)

        # E. The rogue directory precedes the synthetic sandbox directory;
        # both remain discoverable on PATH.
        $env:PATH = "$rogueRoot;$($script:Sandbox.BinDir);$($script:OriginalPath)"

        # F. Confirm, via the same Get-Command -All selection logic
        # production uses, that the rogue ExternalScript really is the
        # first accepted candidate with this PATH ordering — the
        # precondition the rest of this regression depends on.
        $rogueSelection = Get-ChildGcloudSelection
        $rogueSourceMatches = $false
        if ($rogueSelection.Selected -and -not [string]::IsNullOrEmpty($rogueSelection.Source)) {
            $rogueSourceMatches = ([System.IO.Path]::GetFullPath($rogueSelection.Source)).Equals([System.IO.Path]::GetFullPath($roguePs1Path), [System.StringComparison]::OrdinalIgnoreCase)
        }
        $rogueIsFirstCandidate = ($rogueSelection.Selected -eq $true) -and $rogueSourceMatches -and ($rogueSelection.CommandType -ceq 'ExternalScript')
        Assert-That -Condition $rogueIsFirstCandidate -Name 'ROGUE-F: with the rogue directory prepended, the rogue gcloud.ps1 ExternalScript is confirmed (via Get-Command -All) to be the first Application-or-ExternalScript candidate'

        # G. The corrected gate must fail — it examines the actual first
        # candidate, not merely whether the synthetic Application exists
        # somewhere in the list.
        $gateResultWithRogueFirst = Test-ChildResolvesToSyntheticGcloud -ExpectedGcloudCmdPath $script:Sandbox.GcloudCmd
        Assert-That -Condition (-not $gateResultWithRogueFirst) -Name 'ROGUE-G: Test-ChildResolvesToSyntheticGcloud fails when a rogue ExternalScript precedes the synthetic executable on PATH'

        # H. The gate only ever calls Get-Command — it must never invoke
        # the candidate it inspects. The marker file absence is direct
        # proof the rogue script was never executed.
        $markerExistsAfterGateCheck = Test-Path -LiteralPath $markerPath -PathType Leaf
        Assert-That -Condition (-not $markerExistsAfterGateCheck) -Name 'ROGUE-H: the rogue ExternalScript execution marker does not exist after the gate check — the rogue candidate was inspected via Get-Command but never invoked'

        # I. Restoring normal PATH ordering (rogue directory removed) must
        # make the gate pass again.
        $env:PATH = "$($script:Sandbox.BinDir);$($script:OriginalPath)"
        $gateResultAfterRestore = Test-ChildResolvesToSyntheticGcloud -ExpectedGcloudCmdPath $script:Sandbox.GcloudCmd
        Assert-That -Condition $gateResultAfterRestore -Name 'ROGUE-I: after restoring normal PATH ordering (rogue directory removed), the gate passes again'

        # A second, final marker check: even after re-running the gate
        # post-restore, the rogue script (no longer discoverable) was still
        # never executed at any point during this regression.
        $markerExistsAfterRestore = Test-Path -LiteralPath $markerPath -PathType Leaf
        Assert-That -Condition (-not $markerExistsAfterRestore) -Name 'ROGUE-H2: the rogue ExternalScript execution marker still does not exist after PATH restoration and the second gate check'

        # K/L. Full-harness ordering guarantee, strengthened: a genuine
        # Invoke-Scenario call — not just the isolated gate function —
        # must abort the ENTIRE scenario before the production script is
        # ever launched when the rogue candidate precedes the synthetic
        # executable, producing zero synthetic-gcloud invocations and no
        # report file. This proves the gate failure never falls through to
        # invoking the production script against another gcloud candidate.
        $rogueScenarioName = 'Rogue-FullScenario-Abort'
        $rogueScenarioResult = Invoke-Scenario -Name $rogueScenarioName -Fixtures $aFixtures -CliParams @{
            ProjectId     = $aProjectId
            Region        = $aRegion
            TasksLocation = $aTasksLocation
        } -PathPrefix $rogueRoot -ExpectResolutionFailure
        Assert-That -Condition ($null -eq $rogueScenarioResult) -Name 'ROGUE-K: a full Invoke-Scenario call aborts (returns no result) when the rogue candidate precedes the synthetic executable on PATH'

        $rogueScenarioDir = Join-Path -Path $script:Sandbox.ScenariosDir -ChildPath ($rogueScenarioName -replace '[^A-Za-z0-9\-]', '_')
        $rogueScenarioLogPath = Join-Path -Path $rogueScenarioDir -ChildPath 'invocation-log.jsonl'
        $rogueScenarioReportPath = Join-Path -Path $rogueScenarioDir -ChildPath 'report.json'
        $rogueScenarioLogLines = @()
        if (Test-Path -LiteralPath $rogueScenarioLogPath -PathType Leaf) {
            $rogueScenarioLogLines = @(Get-Content -LiteralPath $rogueScenarioLogPath | Where-Object { $_.Trim().Length -gt 0 })
        }
        Assert-That -Condition ($rogueScenarioLogLines.Count -eq 0) -Name 'ROGUE-L: the aborted full scenario produced zero synthetic-gcloud invocations — the production script was never launched, and resolution never fell through to another gcloud candidate'
        Assert-That -Condition (-not (Test-Path -LiteralPath $rogueScenarioReportPath -PathType Leaf)) -Name 'ROGUE-M: the aborted full scenario produced no report file'
    }
    finally {
        # J. PATH and rogue-directory cleanup happen unconditionally,
        # regardless of pass/fail above.
        $env:PATH = "$($script:Sandbox.BinDir);$($script:OriginalPath)"
        if ($rogueRoot -and (Test-Path -LiteralPath $rogueRoot)) {
            Remove-Item -LiteralPath $rogueRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    $env:PATH = $script:OriginalPath
    Remove-Sandbox -Root $script:Sandbox.Root
}

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------

$total = $script:AssertionResults.Count
$passed = @($script:AssertionResults | Where-Object { $_.Passed }).Count
$failed = $total - $passed

Write-Host ''
Write-Host '=== Runtime Harness Summary ==='
Write-Host "TOTAL: $total"
Write-Host "PASSED: $passed"
Write-Host "FAILED: $failed"

if ($failed -gt 0) {
    Write-Host ''
    Write-Host 'Failing assertions:'
    $script:AssertionResults | Where-Object { -not $_.Passed } | ForEach-Object { Write-Host "  - $($_.Name)" }
    exit 1
}

exit 0
