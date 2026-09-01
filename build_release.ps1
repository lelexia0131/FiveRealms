Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ReleaseRoot = Join-Path -Path $ProjectRoot -ChildPath "FiveRealms1.0.0"

if ([IO.Path]::GetFullPath($ReleaseRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) -eq
    $ProjectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)) {
    throw "Release directory must not be the project root."
}

if (Test-Path -LiteralPath $ReleaseRoot) {
    Remove-Item -LiteralPath $ReleaseRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null

function Copy-WhitelistedFile {
    param(
        [Parameter(Mandatory)]
        [string]$RelativePath
    )

    $source = Join-Path -Path $ProjectRoot -ChildPath $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Whitelisted file not found: $RelativePath"
    }

    $destination = Join-Path -Path $ReleaseRoot -ChildPath $RelativePath
    $destinationParent = Split-Path -Path $destination -Parent
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

# The page entry is the only required file at the release root.
$runtimeRootFiles = @(
    "index.html"
)

# Stylesheets loaded directly by index.html.
$runtimeCssFiles = @(
    "css/reset.css",
    "css/theme.css",
    "css/layout.css",
    "css/characters.css",
    "css/cards.css",
    "css/components.css",
    "css/rulebook.css",
    "css/history.css",
    "css/animations.css"
)

# The complete ES module graph and Worker entry points live under js; copy JavaScript files only.
$runtimeJsFiles = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "js") -File -Recurse -Filter "*.js" |
    ForEach-Object { $_.FullName.Substring($ProjectRoot.Length + 1) }

# Runtime card/character art, UI glyphs, and the lightning sound; docs and the unused favicon are excluded.
$runtimeAssetFiles = @(
    "assets/audio/lightning.wav",
    "assets/ui/charge-glyph.svg",
    "assets/ui/recover-glyph.svg",
    "assets/ui/shield-glyph.svg",
    "assets/characters/blade-walker.svg",
    "assets/characters/ember-magus.svg",
    "assets/characters/fate-gambler.svg",
    "assets/characters/oath-warden.svg",
    "assets/characters/resonance-tuner.svg",
    "assets/characters/shade-agent.svg",
    "assets/characters/spirit-medic.svg",
    "assets/characters/trail-hunter.svg",
    "assets/cards/assault.svg",
    "assets/cards/barrier-device.svg",
    "assets/cards/battle-device.svg",
    "assets/cards/block.svg",
    "assets/cards/charge.svg",
    "assets/cards/counter.svg",
    "assets/cards/defense-device.svg",
    "assets/cards/destroy.svg",
    "assets/cards/duel.svg",
    "assets/cards/energy-device.svg",
    "assets/cards/expose-weakness.svg",
    "assets/cards/harvest.svg",
    "assets/cards/leverage.svg",
    "assets/cards/lightning.svg",
    "assets/cards/mutual-benefit.svg",
    "assets/cards/plunder.svg",
    "assets/cards/provoke.svg",
    "assets/cards/recover.svg",
    "assets/cards/recycle-device.svg",
    "assets/cards/scout.svg",
    "assets/cards/seal.svg",
    "assets/cards/shield.svg",
    "assets/cards/shockwave.svg",
    "assets/cards/symbiosis.svg",
    "assets/cards/telescope.svg",
    "assets/cards/transfer.svg"
)

foreach ($file in $runtimeRootFiles + $runtimeCssFiles + $runtimeJsFiles + $runtimeAssetFiles) {
    Copy-WhitelistedFile -RelativePath $file
}

# history_data.json is an optional runtime snapshot; a clean checkout initializes it on first use.
if (Test-Path -LiteralPath (Join-Path $ProjectRoot "history_data.json") -PathType Leaf) {
    Copy-WhitelistedFile -RelativePath "history_data.json"
}

Write-Output "Release directory: $ReleaseRoot"
Write-Output "Whitelisted runtime files copied successfully."
