# Runs against the PRODUCTION build with an index.html fallback: CI's dev server cannot show a
# broken base path (every /splits/join link stayed blank until 5.20.0).
param(
    [ValidateSet('ci', 'shots', 'only')][string]$Mode = 'ci',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$PlaywrightArgs = @()
)
# docker and npm write progress to stderr: under 'Stop' PowerShell 5.1 turns that into a terminating error
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root 'apps\web'

docker compose -f (Join-Path $root 'deploy\docker-compose.test.yml') up --build -d --wait
if ($LASTEXITCODE -ne 0) { throw 'the test stack did not start' }

Push-Location $web
try {
    # the browser runs inside the compose network: the API is reached by service name
    $env:VITE_API_URL = 'http://api:8080'
    npm run build | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }
    # the image tag follows the installed runner so the browser builds match
    $ver = node -p "require('@playwright/test/package.json').version"
    if ($LASTEXITCODE -ne 0 -or -not $ver) { throw 'could not resolve @playwright/test version' }
}
finally {
    Remove-Item Env:VITE_API_URL -ErrorAction SilentlyContinue
    Pop-Location
}

# 5174 is the origin the test API's CORS allows
$serve = 'python3 /work/deploy/spa-serve.py 5174 dist >/dev/null 2>&1 &'
switch ($Mode) {
    'ci' {
        $run = "$serve npx playwright test"
        $extra = @('-e', 'CI=1')
    }
    'shots' {
        $run = "$serve npx playwright test; E=`$?; npx playwright test -c playwright.shots.config.ts; S=`$?; [ `$E -eq 0 ] && [ `$S -eq 0 ]"
        $extra = @('-e', 'PW_WEBKIT=1')
    }
    'only' {
        $run = "$serve npx playwright test $($PlaywrightArgs -join ' ')"
        $extra = @('-e', 'PW_WEBKIT=1')
    }
}

if ($env:PW_VARIANT) { $extra += @('-e', "PW_VARIANT=$($env:PW_VARIANT)") }

docker run --rm --network munni-e2e_default -v "${root}:/work" -w /work/apps/web `
    @extra -e PW_BASE_URL='http://localhost:5174' -e E2E_API_URL='http://api:8080' `
    "mcr.microsoft.com/playwright:v$ver-noble" sh -c $run
exit $LASTEXITCODE
