$ErrorActionPreference = 'Stop'

$shell = $null
$shortcut = $null
$shellApplication = $null
$shellFolder = $null
$shellItem = $null
$shellLink = $null
$status = 2

function Resolve-DshPathIdentity([string] $path) {
  $fullPath = [IO.Path]::GetFullPath($path)
  if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
    return (Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop).FullName
  }
  return $fullPath
}

function Test-DshAbsolutePath([string] $path) {
  if ([String]::IsNullOrWhiteSpace($path)) { return $false }
  try {
    if (-not [IO.Path]::IsPathRooted($path)) { return $false }
    [void] [IO.Path]::GetFullPath($path)
    return $true
  } catch {
    return $false
  }
}

function Read-DshShellShortcutTarget([string] $path) {
  $script:shellApplication = New-Object -ComObject Shell.Application
  $script:shellFolder = $script:shellApplication.Namespace([IO.Path]::GetDirectoryName($path))
  if ($null -eq $script:shellFolder) { throw 'shortcut directory is unavailable' }
  $script:shellItem = $script:shellFolder.ParseName([IO.Path]::GetFileName($path))
  if ($null -eq $script:shellItem) { throw 'shortcut item is unavailable' }
  $script:shellLink = $script:shellItem.GetLink
  if ($null -eq $script:shellLink) { throw 'shortcut link is unavailable' }
  return $script:shellLink.Path
}

function Read-DshWScriptShortcutTarget([string] $path) {
  $script:shell = New-Object -ComObject WScript.Shell
  $script:shortcut = $script:shell.CreateShortcut($path)
  return $script:shortcut.TargetPath
}

function Read-DshShortcutTarget([string] $path) {
  if ($path -match '[^\x00-\x7F]') {
    try { $target = Read-DshShellShortcutTarget $path } catch {
      # A Shell link lookup can fail while WScript can still read its stored target.
      $target = $null
    }
    if (Test-DshAbsolutePath $target) { return $target }
    return Read-DshWScriptShortcutTarget $path
  }
  try {
    $target = Read-DshWScriptShortcutTarget $path
    if (Test-DshAbsolutePath $target) { return $target }
  } catch {
    if ($null -ne $script:shortcut) {
      [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:shortcut)
      $script:shortcut = $null
    }
    if ($null -ne $script:shell) {
      [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:shell)
      $script:shell = $null
    }
  }
  return Read-DshShellShortcutTarget $path
}

try {
  $shortcutPath = $env:DSH_INSTALLER_SHORTCUT
  $targetPaths = @($env:DSH_INSTALLER_OLD_TARGET_EXE, $env:DSH_INSTALLER_NEW_TARGET_EXE) |
    Where-Object { -not [String]::IsNullOrWhiteSpace($_) }
  if (-not [IO.Path]::IsPathRooted($shortcutPath) -or $targetPaths.Count -eq 0) { throw 'invalid shortcut inputs' }
  if (@($targetPaths | Where-Object { -not [IO.Path]::IsPathRooted($_) }).Count -ne 0) { throw 'invalid target inputs' }
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
    $status = 10
  } else {
    $rawShortcutTarget = Read-DshShortcutTarget $shortcutPath
    if (-not (Test-DshAbsolutePath $rawShortcutTarget)) { throw 'shortcut target is not an absolute path' }
    $shortcutTarget = Resolve-DshPathIdentity $rawShortcutTarget
    $owned = @($targetPaths | Where-Object {
      [String]::Equals($shortcutTarget, (Resolve-DshPathIdentity $_), [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    $status = $(if ($owned) { 0 } else { 11 })
  }
} catch {
  [Console]::Error.Write("inspect-shortcut failed: type=$($_.Exception.GetType().FullName) hresult=$($_.Exception.HResult) message=$($_.Exception.Message)")
  $status = 2
} finally {
  if ($null -ne $shellLink) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellLink) }
  if ($null -ne $shellItem) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellItem) }
  if ($null -ne $shellFolder) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellFolder) }
  if ($null -ne $shellApplication) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellApplication) }
  if ($null -ne $shortcut) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
  if ($null -ne $shell) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
exit $status
