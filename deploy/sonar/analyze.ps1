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

# --- api: SonarScanner for .NET, dockerized (nothing to install) ---
Write-Host "==> dotnet-sonarscanner (munni-api, dockerized)" -ForegroundColor Cyan
cmd /c "docker build -q -t munni-sonar-dotnet -f `"$repo\deploy\sonar\Dockerfile.dotnet`" `"$repo\deploy\sonar`" 2>&1"
if ($LASTEXITCODE -ne 0) { Write-Error 'failed to build the dotnet scanner image' }
$inner = "dotnet sonarscanner begin /k:munni-api /n:munni-api /d:sonar.host.url=http://host.docker.internal:9000 /d:sonar.token=$token && dotnet build Munni.slnx --no-incremental && dotnet sonarscanner end /d:sonar.token=$token"
cmd /c "docker run --rm -v `"$repo\server`:/src`" munni-sonar-dotnet sh -c `"$inner`" 2>&1"
if ($LASTEXITCODE -ne 0) { Write-Error 'api analysis failed' }

Write-Host "Done - results at $hostUrl" -ForegroundColor Green
