Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The script lives under tools; the project root is its parent directory.
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

$PackageMetadata = Get-Content `
  -LiteralPath (Join-Path $ProjectRoot "package.json") `
  -Raw | ConvertFrom-Json

$ReleaseRoot = Join-Path `
  -Path $ProjectRoot `
  -ChildPath ("FiveRealms" + $PackageMetadata.version)

if (
  [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) -eq
  $ProjectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)
) {
  throw "Release directory must not be the project root."
}

if (Test-Path -LiteralPath $ReleaseRoot) {
  Remove-Item -LiteralPath $ReleaseRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null

# Copy the complete browser and Electron runtime.
Copy-Item `
  -LiteralPath (Join-Path $ProjectRoot "index.html") `
  -Destination $ReleaseRoot `
  -Force

foreach ($directory in @("css", "js", "assets", "electron")) {
  $source = Join-Path $ProjectRoot $directory

  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Runtime directory not found: $directory"
  }

  Copy-Item `
    -LiteralPath $source `
    -Destination (Join-Path $ReleaseRoot $directory) `
    -Recurse `
    -Force
}

# Always start a release with a fresh history archive.
$emptyHistoryJson = @'
{
  "version": 1,
  "profile": {},
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
    "completedMatches": 0,
    "lostMvpStreak": 0,
    "maxLostMvpStreak": 0,
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

Set-Content `
  -LiteralPath (Join-Path $ReleaseRoot "history_data.json") `
  -Value $emptyHistoryJson `
  -Encoding UTF8

Write-Output "Release directory: $ReleaseRoot"
Write-Output "Complete browser and Electron runtime copied successfully."