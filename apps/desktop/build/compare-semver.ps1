$ErrorActionPreference = 'Stop'

function ConvertFrom-DshSemVer([string] $Value) {
  $pattern = '^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-(?<pre>(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$'
  $match = [Regex]::Match($Value, $pattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if (-not $match.Success) { return $null }
  return [PSCustomObject]@{
    Core = @(
      [Numerics.BigInteger]::Parse($match.Groups['major'].Value),
      [Numerics.BigInteger]::Parse($match.Groups['minor'].Value),
      [Numerics.BigInteger]::Parse($match.Groups['patch'].Value)
    )
    Pre = if ($match.Groups['pre'].Success) { $match.Groups['pre'].Value.Split('.') } else { $null }
  }
}

function Compare-DshSemVer($Left, $Right) {
  for ($index = 0; $index -lt 3; $index++) {
    $comparison = $Left.Core[$index].CompareTo($Right.Core[$index])
    if ($comparison -ne 0) { return [Math]::Sign($comparison) }
  }
  if ($null -eq $Left.Pre -and $null -eq $Right.Pre) { return 0 }
  if ($null -eq $Left.Pre) { return 1 }
  if ($null -eq $Right.Pre) { return -1 }
  $count = [Math]::Min($Left.Pre.Count, $Right.Pre.Count)
  for ($index = 0; $index -lt $count; $index++) {
    $leftIdentifier = $Left.Pre[$index]
    $rightIdentifier = $Right.Pre[$index]
    $leftNumeric = $leftIdentifier -match '^[0-9]+$'
    $rightNumeric = $rightIdentifier -match '^[0-9]+$'
    if ($leftNumeric -and $rightNumeric) {
      $comparison = ([Numerics.BigInteger]::Parse($leftIdentifier)).CompareTo([Numerics.BigInteger]::Parse($rightIdentifier))
    } elseif ($leftNumeric) {
      $comparison = -1
    } elseif ($rightNumeric) {
      $comparison = 1
    } else {
      $comparison = [String]::CompareOrdinal($leftIdentifier, $rightIdentifier)
    }
    if ($comparison -ne 0) { return [Math]::Sign($comparison) }
  }
  return [Math]::Sign($Left.Pre.Count - $Right.Pre.Count)
}

try {
  $installed = ConvertFrom-DshSemVer $env:DSH_INSTALLER_INSTALLED_VERSION
  $candidate = ConvertFrom-DshSemVer $env:DSH_INSTALLER_CANDIDATE_VERSION
  if ($null -eq $installed -or $null -eq $candidate) { exit 2 }
  [Console]::Out.Write((Compare-DshSemVer $installed $candidate))
} catch {
  exit 2
}
