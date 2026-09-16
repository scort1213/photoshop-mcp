param(
    [string]$RunRoot=$env:ADOBE_BOUNDARY_RUN,
    [Parameter(Mandatory=$true)][int]$TargetId,
    [Parameter(Mandatory=$true)][string]$PythonCommand
)
$ErrorActionPreference='Stop'
if (-not $RunRoot -or $TargetId -le 0) { throw 'Supply a dedicated run directory and positive test document ID' }
$RunRoot=[IO.Path]::GetFullPath($RunRoot).TrimEnd('\')
if ($RunRoot -eq [IO.Path]::GetPathRoot($RunRoot).TrimEnd('\')) { throw 'Do not use a drive root' }
if (-not (Test-Path -LiteralPath $RunRoot -PathType Container)) { throw 'Run directory must already exist' }
$testDir=Join-Path $runRoot ('acl-save-'+[Guid]::NewGuid().ToString('N'))
$resolved=[IO.Path]::GetFullPath($testDir)
if (-not $resolved.StartsWith($runRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Outside test directory' }
New-Item -ItemType Directory -Path $resolved | Out-Null
$originalAcl=Get-Acl -LiteralPath $resolved
$originalSddl=$originalAcl.Sddl
$originalSddl | Set-Content -LiteralPath (Join-Path $runRoot 'readonly-save-original-acl.txt') -Encoding UTF8
$acl=Get-Acl -LiteralPath $resolved
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
$rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Deny)
$acl.AddAccessRule($rule)
try {
    Set-Acl -LiteralPath $resolved -AclObject $acl
    $denied=$false
    try { [IO.File]::WriteAllText((Join-Path $resolved 'must-not-exist.txt'),'probe') } catch [UnauthorizedAccessException] { $denied=$true }
    if (-not $denied) { throw 'Write denial did not take effect' }
    $env:ADOBE_BOUNDARY_RUN=$runRoot
    $env:PYTHONIOENCODING='utf-8'
    & $PythonCommand (Join-Path $PSScriptRoot 'readonly_save_case.py') $resolved $TargetId
    if ($LASTEXITCODE -ne 0) { throw 'MCP permission regression failed' }
} finally {
    Set-Acl -LiteralPath $resolved -AclObject $originalAcl
    $restoredAcl=Get-Acl -LiteralPath $resolved
    $beforeDescriptor=New-Object Security.AccessControl.RawSecurityDescriptor($originalSddl)
    $afterDescriptor=New-Object Security.AccessControl.RawSecurityDescriptor($restoredAcl.Sddl)
    $beforeBytes=New-Object byte[] $beforeDescriptor.DiscretionaryAcl.BinaryLength
    $afterBytes=New-Object byte[] $afterDescriptor.DiscretionaryAcl.BinaryLength
    $beforeDescriptor.DiscretionaryAcl.GetBinaryForm($beforeBytes,0)
    $afterDescriptor.DiscretionaryAcl.GetBinaryForm($afterBytes,0)
    # Set-Acl can set the Windows auto-inherited flag while preserving every
    # access entry, owner, group and inheritance protection setting.
    if ([Convert]::ToBase64String($beforeBytes) -ne [Convert]::ToBase64String($afterBytes) -or
        $beforeDescriptor.Owner -ne $afterDescriptor.Owner -or
        $beforeDescriptor.Group -ne $afterDescriptor.Group -or
        $originalAcl.AreAccessRulesProtected -ne $restoredAcl.AreAccessRulesProtected) { throw 'ACL restoration mismatch' }
    [IO.File]::WriteAllText((Join-Path $resolved 'permission-restored.txt'),'Permission restoration verified')
    @{directory=$resolved;acl_restored=$true;write_after_restore=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'ps-readonly-save-restoration.json') -Encoding UTF8
}
