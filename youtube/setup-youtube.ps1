param([string[]]$ExtensionId, [string]$DownloadDir)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $PSScriptRoot 'tools'
New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Asset([string]$Url, [string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing }
}
function Get-RemoteText([string]$Url) {
  $response = Invoke-WebRequest $Url -UseBasicParsing
  if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
  return [string]$response.Content
}
function Test-Checksum([string]$Path, [string]$Text, [string]$Name) {
  $escapedName = [regex]::Escape($Name)
  $line = ($Text -split "`n" | Where-Object { $_.Trim() -match "^[a-fA-F0-9]{64}\s+\*?$escapedName`$" } | Select-Object -First 1)
  if (!$line) { throw "Missing checksum: $Name" }
  $expected = ($line.Trim() -split '\s+')[0]
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $expected) { throw "Checksum mismatch: $Name" }
}
function Get-VerifiedAsset([string]$Url, [string]$Path, [string]$Text, [string]$Name) {
  if (Test-Path -LiteralPath $Path) {
    try { Test-Checksum $Path $Text $Name; return } catch { Write-Host "Updating $Name" }
  }
  $pendingPath = "$Path.download"
  Invoke-WebRequest -Uri $Url -OutFile $pendingPath -UseBasicParsing
  Test-Checksum $pendingPath $Text $Name
  Move-Item -LiteralPath $pendingPath -Destination $Path -Force
}

$ytBase = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
$ytPath = Join-Path $toolsDir 'yt-dlp.exe'
$ytHashes = Get-RemoteText "$ytBase/SHA2-256SUMS"
Get-VerifiedAsset "$ytBase/yt-dlp.exe" $ytPath $ytHashes 'yt-dlp.exe'

$ffBase = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download'
$ffName = 'ffmpeg-master-latest-win64-gpl.zip'
$ffZip = Join-Path $toolsDir 'ffmpeg.zip'
if (!(Test-Path -LiteralPath (Join-Path $toolsDir 'ffmpeg.exe'))) {
  Get-Asset "$ffBase/$ffName" $ffZip
}
if (Test-Path -LiteralPath $ffZip) {
  $ffHashes = Get-RemoteText "$ffBase/checksums.sha256"
  Get-VerifiedAsset "$ffBase/$ffName" $ffZip $ffHashes $ffName
  $archive = [IO.Compression.ZipFile]::OpenRead($ffZip)
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName -match '/bin/(ffmpeg|ffprobe)\.exe$') {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $toolsDir $entry.Name), $true)
      }
    }
  } finally { $archive.Dispose() }
}

$nodePath = Join-Path $toolsDir 'node.exe'
if (!(Test-Path -LiteralPath $nodePath)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    Copy-Item -LiteralPath $nodeCommand.Source -Destination $nodePath
  } else {
    $release = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts -ne $false -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
    $nodeName = "node-$($release.version)-win-x64.zip"
    $nodeZip = Join-Path $toolsDir 'node.zip'
    Get-Asset "https://nodejs.org/dist/$($release.version)/$nodeName" $nodeZip
    $nodeHashes = Get-RemoteText "https://nodejs.org/dist/$($release.version)/SHASUMS256.txt"
    Test-Checksum $nodeZip $nodeHashes $nodeName
    $archive = [IO.Compression.ZipFile]::OpenRead($nodeZip)
    try {
      $entry = $archive.Entries | Where-Object { $_.FullName -match '/node.exe$' } | Select-Object -First 1
      if (!$entry) { throw 'node.exe not found in archive' }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $nodePath, $true)
    } finally { $archive.Dispose() }
  }
}
$nodeVersion = & $nodePath --version
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22+ is required' }

if (!$ExtensionId) {
  $ids = @()
  foreach ($browserDir in @('Microsoft\Edge\User Data', 'Google\Chrome\User Data')) {
    $userDataDir = Join-Path $env:LOCALAPPDATA $browserDir
    Get-ChildItem -LiteralPath $userDataDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' } | ForEach-Object {
      foreach ($prefName in @('Preferences', 'Secure Preferences')) {
        $prefPath = Join-Path $_.FullName $prefName
        if (Test-Path -LiteralPath $prefPath) {
          try {
            $prefs = Get-Content -LiteralPath $prefPath -Raw | ConvertFrom-Json
            foreach ($property in $prefs.extensions.settings.PSObject.Properties) {
              if ($property.Value.path -and [IO.Path]::GetFullPath($property.Value.path).TrimEnd('\') -eq $projectDir.TrimEnd('\')) { $ids += $property.Name }
            }
          } catch { Write-Verbose "Could not read $prefPath" }
        }
      }
    }
  }
  $ExtensionId = @($ids | Select-Object -Unique)
}
if (!$ExtensionId) { throw 'Load this folder as an unpacked extension first, then rerun setup. Or pass -ExtensionId <id>.' }
foreach ($id in $ExtensionId) { if ($id -notmatch '^[a-p]{32}$') { throw "Invalid extension ID: $id" } }
if (!$DownloadDir) { $DownloadDir = Join-Path $projectDir 'downloads' }
$DownloadDir = [IO.Path]::GetFullPath($DownloadDir)
New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'config.json'), (@{downloadDir=$DownloadDir} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$launcher = Join-Path $PSScriptRoot 'native-host.cmd'
[IO.File]::WriteAllText($launcher, "@echo off`r`n`"%~dp0tools\node.exe`" `"%~dp0native-host.cjs`"`r`n", [Text.Encoding]::ASCII)
$manifestPath = Join-Path $PSScriptRoot 'com.videocatcher.youtube.json'
$manifest = @{ name='com.videocatcher.youtube'; description='Video Catcher YouTube downloader'; path=$launcher; type='stdio'; allowed_origins=@($ExtensionId | ForEach-Object { "chrome-extension://$_/" }) }
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
foreach ($vendor in @('Microsoft\Edge', 'Google\Chrome')) {
  $key = "HKCU:\Software\$vendor\NativeMessagingHosts\com.videocatcher.youtube"
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
}
Write-Host "YouTube helper ready. Node $nodeVersion. Downloads: $DownloadDir"
Write-Host 'Reload Video Catcher in edge://extensions or chrome://extensions, then reload the video page.'
