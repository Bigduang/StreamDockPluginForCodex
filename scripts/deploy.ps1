param(
    [string]$Destination = (Join-Path $env:APPDATA "HotSpot\StreamDock\plugins\com.vvvvv.streamdock.codexhook.sdPlugin")
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pluginsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA "HotSpot\StreamDock\plugins"))
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$destinationParent = [System.IO.Path]::GetDirectoryName($destinationPath)

if ([System.StringComparer]::OrdinalIgnoreCase.Compare($destinationParent, $pluginsRoot) -ne 0) {
    throw "Destination must live directly under $pluginsRoot"
}

$requiredItems = @(
    "manifest.json",
    "package.json",
    "package-lock.json",
    "plugin",
    "propertyInspector",
    "static",
    "node_modules"
)

foreach ($item in $requiredItems) {
    $source = Join-Path $projectRoot $item
    if (-not (Test-Path $source)) {
        throw "Missing required project item: $item"
    }
}

if (Test-Path $destinationPath) {
    try {
        Remove-Item -LiteralPath $destinationPath -Recurse -Force -ErrorAction Stop
    } catch {
        throw "Unable to replace live plugin directory. Close Stream Dock and retry. Path: $destinationPath. Error: $($_.Exception.Message)"
    }
}

New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null

foreach ($item in $requiredItems) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $destinationPath -Recurse -Force
}

Write-Host "Deployed CodexHook plugin to $destinationPath"
Write-Host "Restart Stream Dock after the first install or after redeploying a loaded plugin."
