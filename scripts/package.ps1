param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dist = Join-Path $projectRoot "dist"
$stageRoot = Join-Path $dist "_stage"
$stage = Join-Path $stageRoot "com.vvvvv.streamdock.codexhook.sdPlugin"
$zip = Join-Path $dist "com.vvvvv.streamdock.codexhook.zip"
$output = Join-Path $dist "com.vvvvv.streamdock.codexhook.sdPlugin"
$nodeModules = Join-Path $projectRoot "node_modules"

if (-not $SkipInstall -and -not (Test-Path (Join-Path $nodeModules "ws"))) {
    npm install --omit=dev
}

foreach ($required in @(
    (Join-Path $nodeModules "ws"),
    (Join-Path $nodeModules "ssh2")
)) {
    if (-not (Test-Path $required)) {
        throw "Missing dependency: $required. Run npm install first."
    }
}

if (-not (Test-Path $dist)) {
    New-Item -ItemType Directory -Path $dist | Out-Null
}

$resolvedDist = [System.IO.Path]::GetFullPath($dist)
foreach ($target in @($stageRoot, $zip, $output)) {
    if (Test-Path $target) {
        $resolvedTarget = [System.IO.Path]::GetFullPath($target)
        if (-not $resolvedTarget.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove outside dist: $resolvedTarget"
        }
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
}

New-Item -ItemType Directory -Path $stage | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "static") | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot "manifest.json") -Destination $stage
Copy-Item -LiteralPath (Join-Path $projectRoot "package.json") -Destination $stage
Copy-Item -LiteralPath (Join-Path $projectRoot "package-lock.json") -Destination $stage
Copy-Item -LiteralPath (Join-Path $projectRoot "plugin") -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "propertyInspector") -Destination $stage -Recurse
Copy-Item -LiteralPath $nodeModules -Destination (Join-Path $stage "node_modules") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "static\action-icon.png") -Destination (Join-Path $stage "static\action-icon.png")
Copy-Item -LiteralPath (Join-Path $projectRoot "static\plugin-icon.png") -Destination (Join-Path $stage "static\plugin-icon.png")

function Remove-StagedPath {
    param([string]$RelativePath)

    $target = Join-Path $stage $RelativePath
    if (-not (Test-Path $target)) {
        return
    }

    $resolvedStage = [System.IO.Path]::GetFullPath($stage)
    $resolvedTarget = [System.IO.Path]::GetFullPath($target)
    if (-not $resolvedTarget.StartsWith($resolvedStage, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove outside package stage: $resolvedTarget"
    }

    Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}

foreach ($relativePath in @(
    "node_modules\.package-lock.json",
    "node_modules\ssh2\.github",
    "node_modules\ssh2\examples",
    "node_modules\ssh2\lib\keygen.js",
    "node_modules\ssh2\lib\server.js",
    "node_modules\ssh2\test",
    "node_modules\ssh2\util",
    "node_modules\ssh2\SFTP.md",
    "node_modules\ssh2\README.md",
    "node_modules\safer-buffer\tests.js",
    "node_modules\safer-buffer\Porting-Buffer.md",
    "node_modules\safer-buffer\Readme.md",
    "node_modules\tweetnacl\PULL_REQUEST_TEMPLATE.md"
)) {
    Remove-StagedPath $relativePath
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
Rename-Item -LiteralPath $zip -NewName (Split-Path $output -Leaf)

Remove-Item -LiteralPath $stageRoot -Recurse -Force

$size = (Get-Item $output).Length
Write-Host "Created package: $output ($([math]::Round($size / 1MB, 2)) MiB)"
