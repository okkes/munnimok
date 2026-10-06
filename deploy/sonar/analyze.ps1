# Runs a local SonarQube analysis of the web app (and the API when the
# .NET sonarscanner + Java are available). One-time setup is described in
# deploy/docker-compose.sonar.yml.
#
#   ./deploy/sonar/analyze.ps1
#
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$hostUrl = 'http://localhost:9000'

# token from deploy/env/.env.local (SONAR_TOKEN=...) or the environment
$token = $env:SONAR_TOKEN
$envFile = Join-Path $repo 'deploy\env\.env.local'
if (-not $token -and (Test-Path $envFile)) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^SONAR_TOKEN=' } | Select-Object -First 1
    if ($line) { $token = $line.Substring('SONAR_TOKEN='.Length).Trim() }
}
if (-not $token) {
    Write-Error "No SONAR_TOKEN found. Generate one at $hostUrl (My Account / Security) and add SONAR_TOKEN=<token> to deploy/env/.env.local"
}

try { Invoke-RestMethod "$hostUrl/api/system/status" | Out-Null } catch {
    Write-Error "SonarQube is not reachable at $hostUrl. Start it with: docker compose -f deploy/docker-compose.sonar.yml up -d"
}

# --- web: coverage + scanner CLI (dockerized, nothing to install) ---
Write-Host "==> vitest coverage (apps/web)" -ForegroundColor Cyan
Push-Location (Join-Path $repo 'apps\web')
try {
    # cmd /c merges the tools' stderr progress output so PS 5.1 does not
    # promote it to a terminating error under redirection
    cmd /c "npx vitest run --coverage --coverage.reporter=lcov 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Error 'vitest failed - fix tests before analyzing' }

    Write-Host "==> sonar-scanner (munni-web)" -ForegroundColor Cyan
    cmd /c "docker run --rm -e SONAR_HOST_URL=http://host.docker.internal:9000 -e SONAR_TOKEN=$token -v `"$PWD`:/usr/src`" sonarsource/sonar-scanner-cli 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Error 'web analysis failed' }
} finally { Pop-Location }

# --- admin: same scanner CLI, tiny project -------------------------------
Write-Host "==> vitest coverage (apps/admin)" -ForegroundColor Cyan
Push-Location (Join-Path $repo 'apps\admin')
try {
    cmd /c "npx vitest run --coverage --coverage.reporter=lcov 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Error 'admin vitest failed - fix tests before analyzing' }

    Write-Host "==> sonar-scanner (munni-admin)" -ForegroundColor Cyan
    cmd /c "docker run --rm -e SONAR_HOST_URL=http://host.docker.internal:9000 -e SONAR_TOKEN=$token -v `"$PWD`:/usr/src`" sonarsource/sonar-scanner-cli 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Error 'admin analysis failed' }
} finally { Pop-Location }

# --- lab: the connector workbench, same regime as admin -------------------
Write-Host "==> vitest coverage (apps/lab)" -ForegroundColor Cyan
Push-Location (Join-Path $repo 'apps\lab')
try {
    npx vitest run --coverage --coverage.reporter=lcov --coverage.reporter=text-summary
    if ($LASTEXITCODE -ne 0) { Write-Error 'lab vitest failed - fix tests before analyzing' }

    Write-Host "==> sonar-scanner (munni-lab)" -ForegroundColor Cyan
    docker run --rm -e SONAR_HOST_URL=$sonarHost -e SONAR_TOKEN=$sonarToken -v "${PWD}:/usr/src" sonarsource/sonar-scanner-cli
    if ($LASTEXITCODE -ne 0) { Write-Error 'lab analysis failed' }
} finally { Pop-Location }

# --- control: the shared-services cockpit, same regime as admin ----------
Write-Host "==> vitest coverage (apps/control)" -ForegroundColor Cyan
Push-Location (Join-Path $repo 'apps\control')
try {
    cmd /c "npx vitest run --coverage --coverage.reporter=lcov 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Error 'control vitest failed - fix tests before analyzing' }

    Write-Host "==> sonar-scanner (munni-control)" -ForegroundColor Cyan
    cmd /c "docker run --rm -e SONAR_HOST_URL=http://host.docker.internal:9000 -e SONAR_TOKEN=$token -v `"$PWD`:/usr/src`" sonarsource/sonar-scanner-cli 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Error 'control analysis failed' }
} finally { Pop-Location }

# --- api: SonarScanner for .NET, dockerized (nothing to install) ---
# coverage runs on the HOST (Testcontainers/Docker are unavailable inside
# the scanner container); the opencover report's absolute Windows paths
# are rewritten to the container mount so Sonar can match the files
Write-Host "==> dotnet test coverage (server, host)" -ForegroundColor Cyan
# one results directory for the whole solution: Munni.Api's MSBuild gate
# reads its own report out of it, and the connector assemblies (each
# covered by several suites) are gated on the union by coverage-gate.mjs
$coverageDir = Join-Path $repo 'server\coverage'
if (Test-Path $coverageDir) { Remove-Item $coverageDir -Recurse -Force }
$testResults = Join-Path $coverageDir 'results'
Push-Location (Join-Path $repo 'server')
try {
    cmd /c "dotnet test Munni.slnx --nologo -v q --results-directory `"$testResults`" --collect:`"XPlat Code Coverage;Format=opencover,cobertura`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Error 'dotnet test failed - fix tests before analyzing' }
    cmd /c "node tests\coverage-gate.mjs `"$testResults`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Error 'coverage gate failed - add behavior tests before analyzing' }
} finally { Pop-Location }
$reports = @(Get-ChildItem $testResults -Recurse -Filter coverage.opencover.xml)
if ($reports.Count -eq 0) { Write-Error 'no opencover report produced' }
$serverPrefix = [regex]::Escape((Join-Path $repo 'server') + '\')
$evaluator = { param($m) 'fullPath="/src/' + ($m.Groups[1].Value -replace '\\', '/') + '"' }
$n = 0
foreach ($report in $reports) {
    $rewritten = [regex]::Replace((Get-Content $report.FullName -Raw), "fullPath=`"$serverPrefix([^`"]*)`"", $evaluator)
    Set-Content -Path (Join-Path $coverageDir "opencover-$n.xml") -Value $rewritten -Encoding utf8
    $n++
}

Write-Host "==> dotnet-sonarscanner (munni-api, dockerized)" -ForegroundColor Cyan
cmd /c "docker build -q -t munni-sonar-dotnet -f `"$repo\deploy\sonar\Dockerfile.dotnet`" `"$repo\deploy\sonar`" 2>&1"
if ($LASTEXITCODE -ne 0) { Write-Error 'failed to build the dotnet scanner image' }
# EF migrations are generated code — excluded from analysis
# the host test run leaves Windows-built obj/bin behind — the Linux
# build inside the container chokes on them (MSB3491), so start clean
# bin/obj hold the build's copies of every fixture and Playwright's own
# JavaScript (the .NET scanner walks each project folder for non-.NET files,
# eight times over); the fixtures are recorded third-party pages, not code
$exclusions = '**/Migrations/**,**/bin/**,**/obj/**,**/Fixtures/**'
$inner = "find . -type d -name obj -prune -exec rm -rf {} + ; find . -type d -name bin -prune -exec rm -rf {} + ; dotnet sonarscanner begin /k:munni-api /n:munni-api /d:sonar.host.url=http://host.docker.internal:9000 /d:sonar.token=$token /d:sonar.exclusions=$exclusions /d:sonar.test.exclusions=$exclusions /d:sonar.cs.opencover.reportsPaths=/src/coverage/opencover-*.xml && dotnet build Munni.slnx --no-incremental && dotnet sonarscanner end /d:sonar.token=$token"
cmd /c "docker run --rm -v `"$repo\server`:/src`" munni-sonar-dotnet sh -c `"$inner`" 2>&1"
if ($LASTEXITCODE -ne 0) { Write-Error 'api analysis failed' }

Write-Host "Done - results at $hostUrl" -ForegroundColor Green
