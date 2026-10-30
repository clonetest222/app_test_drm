# Dong bo pattern + ipc toml cho DUNG ban steamclient64.dll dang co tren may,
# tu repo kasakigaming/steam-monitor. Chay truoc khi dung kernel.
#
#   powershell -ExecutionPolicy Bypass -File tools\sync_steam_monitor.ps1
#   (tuy chon) -SteamClient "D:\Steam\steamclient64.dll"
param(
  [string]$SteamClient = "",
  [string]$Repo = "kasakigaming/steam-monitor"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # thu muc kernel\

function Find-SteamClient {
  if ($SteamClient -and (Test-Path $SteamClient)) { return $SteamClient }
  try {
    $sp = (Get-ItemProperty "HKCU:\Software\Valve\Steam" -Name SteamPath -ErrorAction Stop).SteamPath
    $c = Join-Path ($sp -replace '/','\') "steamclient64.dll"
    if (Test-Path $c) { return $c }
  } catch {}
  throw "Khong tim thay steamclient64.dll - truyen tham so -SteamClient duong-dan."
}

$sc = Find-SteamClient
$hash = (Get-FileHash -Algorithm SHA256 -Path $sc).Hash.ToLower()
Write-Host "steamclient64.dll: $sc"
Write-Host "sha256           : $hash"

$pat = Join-Path $root "data\pattern"
$ipc = Join-Path $root "data\ipc"
New-Item -ItemType Directory -Force -Path $pat,$ipc | Out-Null

function Get-Toml($branch, $dest) {
  $url = "https://raw.githubusercontent.com/$Repo/$branch/steamclient/$hash.toml"
  $out = Join-Path $dest "$hash.toml"
  try {
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
    Write-Host "  OK  $branch -> $out"
  } catch {
    Write-Warning "  THIEU $branch cho hash nay ($url). steam-monitor co the chua xuat ban nay."
  }
}
Get-Toml "pattern" $pat
Get-Toml "ipc" $ipc
Write-Host "Xong. Dam bao thu muc data\pattern va data\ipc nam canh dwmapi.dll khi trien khai."
