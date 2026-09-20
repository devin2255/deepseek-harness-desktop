$ErrorActionPreference = 'Stop'

$shell = $null
$shortcut = $null
$status = 2

function Resolve-DshPathIdentity([string] $path) {
  $fullPath = [IO.Path]::GetFullPath($path)
  if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
    return (Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop).FullName
  }
  return $fullPath
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
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcutTarget = Resolve-DshPathIdentity $shortcut.TargetPath
    $owned = @($targetPaths | Where-Object {
      [String]::Equals($shortcutTarget, (Resolve-DshPathIdentity $_), [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    $status = $(if ($owned) { 0 } else { 11 })
  }
} catch {
  $status = 2
} finally {
  if ($null -ne $shortcut) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
  if ($null -ne $shell) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
exit $status
