<#
.SYNOPSIS
  Always opens Yard at the latest version of the local code.

.DESCRIPTION
  Stamps a hash of the sources into src-tauri/target. If nothing changed since
  last time, it just launches the executable (~1 s). If it did, it rebuilds only
  the half that changed — the front end, the binary, or both — and launches.
  This is the everyday shortcut: no installation involved, the .exe is the
  repository's own.

.PARAMETER Installer
  Builds the NSIS installer (scripts/installer.mjs) and exits without opening
  the app.

.PARAMETER Force
  Rebuilds even when the stamp is up to date.

.PARAMETER NoLaunch
  Builds and does not open the app.

.PARAMETER Shortcut
  (Re)creates the Desktop and Start Menu shortcuts and exits.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\yard.ps1
#>
[CmdletBinding()]
param(
  [switch]$Installer,
  [switch]$Force,
  [switch]$NoLaunch,
  [switch]$Shortcut
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $root 'src-tauri\icons\icon.ico'
$scriptPath = Join-Path $PSScriptRoot 'yard.ps1'

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Note([string]$msg) { Write-Host "    $msg" -ForegroundColor DarkGray }
function Write-Warn([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

function Invoke-Step([string]$label, [scriptblock]$block) {
  Write-Step $label
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit code $LASTEXITCODE)." }
}

function New-YardShortcut([string]$lnkPath) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
  $lnk.WorkingDirectory = $root
  $lnk.Description = 'Yard — always opens the latest build of the repository'
  if (Test-Path $iconPath) { $lnk.IconLocation = $iconPath }
  $lnk.Save()
  Write-Note $lnkPath
}

# Hash of a set of sources. `dist/` is deliberately out of every set: it is
# vite's output and its mtime changes on every build, which would keep the
# stamp from ever matching.
function Get-Fingerprint([string[]]$dirs, [string[]]$loose) {
  $files = @()
  foreach ($dir in $dirs) {
    $full = Join-Path $root $dir
    if (Test-Path $full) {
      $files += Get-ChildItem -Path $full -Recurse -File |
        Where-Object { $_.Name -notmatch '\.test\.(ts|tsx)$' }
    }
  }
  foreach ($file in $loose) {
    $full = Join-Path $root $file
    if (Test-Path $full) { $files += Get-Item $full }
  }

  $sb = New-Object System.Text.StringBuilder
  foreach ($f in ($files | Sort-Object FullName)) {
    [void]$sb.AppendLine("$($f.FullName)|$($f.Length)|$($f.LastWriteTimeUtc.Ticks)")
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sb.ToString()))
  return ([System.BitConverter]::ToString($bytes)).Replace('-', '')
}

# Two sets, two stamps. They go stale for different reasons, and a change under
# `src-tauri\src` has no business paying for a front-end build it cannot have
# affected. The launcher itself is in both: it is where the build flags live.
$frontendDirs = @('src', 'public')
$frontendLoose = @(
  'index.html', 'package.json', 'package-lock.json', 'vite.config.ts',
  'tsconfig.json', 'tsconfig.node.json', 'scripts\yard.ps1'
)
$rustDirs = @('src-tauri\src', 'src-tauri\capabilities', 'src-tauri\icons')
$rustLoose = @(
  'src-tauri\Cargo.toml', 'src-tauri\Cargo.lock', 'src-tauri\tauri.conf.json',
  'src-tauri\build.rs', 'scripts\yard.ps1'
)

if ($Shortcut) {
  Write-Step 'Creating shortcuts'
  New-YardShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Yard.lnk')
  New-YardShortcut (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Yard.lnk')
  exit 0
}

if ($Installer) {
  Write-Step 'NSIS installer (full release build, a few minutes)'
  Push-Location $root
  try {
    # scripts/installer.mjs looks for the updater's minisign key *before*
    # compiling: with it the artifacts are signed as in CI, without it they are
    # dropped. Calling `tauri build` straight would spend the whole build only
    # to refuse on the last line ("a public key has been found, but no private
    # key").
    Invoke-Step 'tauri build' { & node scripts/installer.mjs }
  } finally {
    Pop-Location
  }
  $setup = Get-ChildItem (Join-Path $root 'src-tauri\target\release\bundle\nsis') -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($setup) { Write-Step "Done: $($setup.FullName)" }
  exit 0
}

# One profile, on purpose. A second one (the old `release-fast`) meant cargo
# kept two full copies of ~600 compiled dependencies — 2.4 GB and a ten-minute
# rebuild every time you moved between the launcher and the installer. The
# `release` profile in Cargo.toml is tuned to be quick enough that the launcher
# can use it too.
$exe = Join-Path $root 'src-tauri\target\release\yard.exe'
$frontendStamp = Join-Path $root 'src-tauri\target\.yard-launcher-frontend'
$rustStamp = Join-Path $root 'src-tauri\target\.yard-launcher-rust'

# Windows locks the .exe while the app is running: here we just lean on Tauri's
# single-instance lock, which brings the existing window to the front.
$running = Get-Process -Name 'yard' -ErrorAction SilentlyContinue
if ($running) {
  Write-Warn 'Yard is already open — close it first if you want to rebuild.'
  if (-not $NoLaunch -and (Test-Path $exe)) { Start-Process -FilePath $exe }
  exit 0
}

function Test-Stale([string]$stampFile, [string]$fingerprint) {
  if ($Force) { return $true }
  if (-not (Test-Path $stampFile)) { return $true }
  return ((Get-Content $stampFile -Raw).Trim() -ne $fingerprint)
}

$frontendPrint = Get-Fingerprint $frontendDirs $frontendLoose
$rustPrint = Get-Fingerprint $rustDirs $rustLoose
$noExe = -not (Test-Path $exe)
$frontendStale = $noExe -or -not (Test-Path (Join-Path $root 'dist\index.html')) -or (Test-Stale $frontendStamp $frontendPrint)
$rustStale = $noExe -or (Test-Stale $rustStamp $rustPrint)

if ($frontendStale -or $rustStale) {
  $started = Get-Date
  Push-Location $root
  try {
    if ($frontendStale) {
      Invoke-Step 'Front-end build (tsc + vite)' { & npm run build }
      Set-Content -Path $frontendStamp -Value $frontendPrint -Encoding utf8
    } else {
      Write-Note 'Front end unchanged — skipping tsc + vite.'
    }
    # Always compiled, even when only the front end moved: cargo decides. The
    # assets `generate_context!` embeds come back as `include_bytes!` of the
    # real files in `dist/`, so rustc's dep-info relinks the binary by itself
    # and this call costs a second when there is nothing to do.
    #
    # `tauri/custom-protocol` is what separates production from dev in Tauri 2:
    # without it, tauri's build.rs turns on the `dev` cfg and the window goes
    # looking for devUrl (localhost:1420) instead of the embedded dist. The CLI
    # passes the feature behind the scenes; a raw `cargo build` does not.
    Invoke-Step 'Compiling the binary (release)' {
      & cargo build --release --features tauri/custom-protocol --manifest-path src-tauri\Cargo.toml
    }
    Set-Content -Path $rustStamp -Value $rustPrint -Encoding utf8
    $secs = [int]((Get-Date) - $started).TotalSeconds
    Write-Step "Build updated in ${secs}s"
  } catch {
    Pop-Location
    Write-Warn $_.Exception.Message
    if ((Test-Path $exe) -and -not $NoLaunch) {
      Write-Warn 'Opening the previous build — the new changes are NOT in it.'
      Start-Process -FilePath $exe
    }
    exit 1
  }
  Pop-Location
} else {
  Write-Step 'Build is already up to date'
}

if ($NoLaunch) { exit 0 }
Write-Step "Opening $exe"
Start-Process -FilePath $exe -WorkingDirectory $root
