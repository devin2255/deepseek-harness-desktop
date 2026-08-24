$ErrorActionPreference = 'Stop'

$shell = $null
$shortcut = $null
try {
  $shortcutPath = $env:DSH_INSTALLER_SHORTCUT
  $targetPaths = @($env:DSH_INSTALLER_OLD_TARGET_EXE, $env:DSH_INSTALLER_NEW_TARGET_EXE) |
    Where-Object { -not [String]::IsNullOrWhiteSpace($_) }
  if (-not [IO.Path]::IsPathRooted($shortcutPath) -or $targetPaths.Count -eq 0) { exit 2 }
  if (@($targetPaths | Where-Object { -not [IO.Path]::IsPathRooted($_) }).Count -ne 0) { exit 2 }
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
    [Console]::Out.Write('missing')
    exit 0
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $owned = @($targetPaths | Where-Object {
    [String]::Equals($shortcut.TargetPath, $_, [StringComparison]::OrdinalIgnoreCase)
  }).Count -gt 0
  [Console]::Out.Write($(if ($owned) { 'owned' } else { 'foreign' }))
} catch {
  exit 2
} finally {
  if ($null -ne $shortcut) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
  if ($null -ne $shell) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
