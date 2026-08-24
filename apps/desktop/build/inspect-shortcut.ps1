$ErrorActionPreference = 'Stop'

$shell = $null
$shortcut = $null
try {
  $shortcutPath = $env:DSH_INSTALLER_SHORTCUT
  $targetPath = $env:DSH_INSTALLER_TARGET_EXE
  if (-not [IO.Path]::IsPathRooted($shortcutPath) -or -not [IO.Path]::IsPathRooted($targetPath)) { exit 2 }
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
    [Console]::Out.Write('missing')
    exit 0
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $owned = [String]::Equals($shortcut.TargetPath, $targetPath, [StringComparison]::OrdinalIgnoreCase)
  [Console]::Out.Write($(if ($owned) { 'owned' } else { 'foreign' }))
} catch {
  exit 2
} finally {
  if ($null -ne $shortcut) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
  if ($null -ne $shell) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
