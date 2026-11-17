# All of iOS (Safari, PWA, native webviews) renders with WebKit, whose flex sizing is stricter than
# Blink's: layout bugs invisible to jsdom and the chromium run live here (sheets collapsed to their
# header on iOS). Runs in a container, nothing installed on the host; needs docker and a prior `npm ci`.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root 'apps\web'

Write-Host '-- building the web app (host toolchain, as always)'
Push-Location $web
try {
    npm run build | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }
}
finally { Pop-Location }

# image tag pinned to the installed @playwright/test (hoisted to the root node_modules) so browser builds match
Push-Location $web
try { $ver = node -p "require('@playwright/test/package.json').version" }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0 -or -not $ver) { throw 'could not resolve @playwright/test version' }
$img = "mcr.microsoft.com/playwright:v$ver-noble"

Write-Host "-- running the webkit project in $img"
docker run --rm -v "${root}:/work" -w /work/apps/web `
    -e PW_WEBKIT=1 -e PW_BASE_URL='http://localhost:4173' `
    $img sh -c 'python3 -m http.server 4173 -d dist >/dev/null 2>&1 & npx playwright test --project=webkit'
exit $LASTEXITCODE
