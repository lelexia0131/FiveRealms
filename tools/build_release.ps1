Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The script lives under tools; the project root is its parent directory.
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$ReleaseRoot = Join-Path -Path $ProjectRoot -ChildPath "FiveRealms1.1.0"

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
    "css/achievements.css",
    "css/animations.css"
)

# The complete ES module graph and Worker entry points live under js; copy JavaScript files only.
$runtimeJsFiles = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "js") -File -Recurse -Filter "*.js" |
ForEach-Object { $_.FullName.Substring($ProjectRoot.Length + 1) }

# Achievement artwork is a runtime-owned directory so new SVGs are included without whitelist edits.
$runtimeAchievementAssetFiles = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "assets/achievements") -File -Filter "*.svg" |
Sort-Object FullName |
ForEach-Object { $_.FullName.Substring($ProjectRoot.Length + 1) }

# Runtime card/character art, UI glyphs, the launcher icon, and the lightning sound; docs are excluded.
$runtimeAssetFiles = @(
    "assets/audio/lightning.wav",
    "assets/ui/five-realms.ico",
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

foreach ($file in $runtimeRootFiles + $runtimeCssFiles + $runtimeJsFiles + $runtimeAssetFiles + $runtimeAchievementAssetFiles) {
    Copy-WhitelistedFile -RelativePath $file
}

# Always start a release with a fresh history archive; never carry over local match data.
$emptyHistoryJson = @'
{
  "version": 1,
  "summary": {
    "totalMatches": 0,
    "wins": 0,
    "losses": 0,
    "mvpCount": 0,
    "highestScore": 0,
    "highestRounds": 0,
    "totalScore": 0,
    "totalRounds": 0,
    "currentWinStreak": 0,
    "maxWinStreak": 0
  },
  "characters": {},
  "teams": {},
  "achievements": {
    "schemaVersion": 1,
    "records": {},
    "streaks": {
      "duo": {
        "win": 0,
        "maxWin": 0,
        "mvp": 0,
        "maxMvp": 0
      },
      "trio": {
        "win": 0,
        "maxWin": 0,
        "mvp": 0,
        "maxMvp": 0
      }
    },
    "companions": {},
    "highestSingleMatchDamage": null,
    "highestSingleMatchKills": null,
    "highestSingleMatchSupport": null,
    "highestSingleMatchDamageTaken": null
  },
  "records": []
}
'@
Set-Content -LiteralPath (Join-Path $ReleaseRoot "history_data.json") -Value $emptyHistoryJson -Encoding UTF8

Write-Output "Release directory: $ReleaseRoot"
Write-Output "Whitelisted runtime files copied successfully."
