param([switch]$Status)
#Requires -Version 5.1
<#
Cat Town workshop installer. Builds the WSL2 distro "cat-workshop" and installs the tools the Mayor approved.
Usage: powershell -ExecutionPolicy Bypass -File scripts\workshop\install-workshop.ps1 [-Status]
Re-running resumes: each step is recorded in %LOCALAPPDATA%\cat-town\workshop\state.json after it finishes.
Approved requests come from the newest data\season-*.jsonl (capability.requested + capability.decided, tier sandbox).
Results are appended to data\workshop.jsonl. Rules: docs\workshop-spec.md. Overview: docs\workshop.md.

Status of this file: first run on the owner's machine 2026-10-26 by auto setup exposed a wsl.conf quoting bug, fixed below.
NOT TESTED:
- WSL is not installed on the build machine, so wsl --import, wsl --exec argument passing, and /etc/wsl.conf were never exercised.
- The rootfs was NOT downloaded. The SHA256 below was copied from the official SHA256SUMS at cdimage.ubuntu.com (fetched this session); the tarball itself was not hashed.
- apt, useradd, npm, pip, git and the licence checks against registry.npmjs.org and pypi.org were not run.
- Resume after a Ctrl-C at each step was not exercised.
- The licence check on repos is a text heuristic over LICENSE, not an SPDX scan.
- Ubuntu 24.04.5 is the newest base listed in SHA256SUMS; no check was made for a later point release.
#>

$ErrorActionPreference='Stop'
$env:WSL_UTF8='1'
$Version='24.04.5'
$Sha256='e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86'
$Url="https://cdimage.ubuntu.com/ubuntu-base/releases/noble/release/ubuntu-base-$Version-base-amd64.tar.gz"
$Distro='cat-workshop'
$User='catworker'
$Root=Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$DataDir=if($env:CAT_TOWN_DATA){$env:CAT_TOWN_DATA}else{Join-Path $Root 'data'}
$StateDir=Join-Path $env:LOCALAPPDATA 'cat-town\workshop'
$StateFile=Join-Path $StateDir 'state.json'
$Tarball=Join-Path $StateDir "ubuntu-base-$Version-base-amd64.tar.gz"
$DistroDir=Join-Path $StateDir 'distro'
$ResultsFile=Join-Path $DataDir 'workshop.jsonl'
# Same rules as src/economy.ts (PACKAGE_SOURCE, REPO_SOURCE); cased exactly, so -cmatch.
$PackageSource='^(npm|pypi):((?:@[a-z0-9._-]+/)?[a-z0-9][a-z0-9._-]{0,80})$'
$RepoSource='^https://github\.com/[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'
$Allowed=@('MIT','Apache-2.0','BSD-2-Clause','BSD-3-Clause','ISC')

function Read-State{
  if(-not (Test-Path -LiteralPath $StateFile)){return @{}}
  $o=Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
  $h=@{}; foreach($p in $o.PSObject.Properties){$h[$p.Name]=$p.Value}
  return $h
}
function Save-State{
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  $tmp="$StateFile.tmp"
  $State | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $StateFile -Force
}
$State=Read-State
function Mark($key,$value){$State[$key]=$value;Save-State}

function Get-Distros{@(& wsl.exe -l -q | ForEach-Object{($_ -replace "`0",'').Trim()} | Where-Object{$_})}
function Get-Running{@(& wsl.exe -l --running -q | ForEach-Object{($_ -replace "`0",'').Trim()} | Where-Object{$_})}
function Invoke-Wsl([string[]]$Arguments){
  & wsl.exe @Arguments | Out-Host
  if($LASTEXITCODE -ne 0){throw "wsl $($Arguments -join ' ') exited with code $LASTEXITCODE"}
}
function Invoke-Guest([string]$Who,[string[]]$Command){Invoke-Wsl (@('-d',$Distro,'-u',$Who,'--exec')+$Command)}

function Test-License([string]$text){
  $tokens=@($text -split '\s+OR\s+|\s+AND\s+|[()]' | Where-Object{$_})
  return ($tokens.Count -gt 0) -and -not ($tokens | Where-Object{$Allowed -notcontains $_})
}
function Get-PackageLicense([string]$kind,[string]$name){
  if($kind -eq 'npm'){$r=Invoke-RestMethod -Uri ('https://registry.npmjs.org/'+($name -replace '/','%2F')+'/latest');return [string]$r.license}
  $r=Invoke-RestMethod -Uri "https://pypi.org/pypi/$name/json"
  return [string]$r.info.license
}
function Get-RepoLicense([string]$text){
  if($text -match 'MIT License'){return 'MIT'}
  if($text -match 'Apache License\s+Version 2\.0'){return 'Apache-2.0'}
  if($text -match 'ISC License'){return 'ISC'}
  if($text -match 'BSD 3-Clause'){return 'BSD-3-Clause'}
  if($text -match 'BSD 2-Clause'){return 'BSD-2-Clause'}
  return $null
}

# Approved sandbox requests from the newest journal. The decision has no kind or source, so join on id.
function Get-Approved{
  $journal=Get-ChildItem -LiteralPath $DataDir -Filter 'season-*.jsonl' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if(-not $journal){return @{journal=$null;items=@()}}
  $lines=@(Get-Content -LiteralPath $journal.FullName -Encoding UTF8)
  $events=@()
  for($i=0;$i -lt $lines.Count;$i++){
    if(-not $lines[$i].Trim()){continue}
    try{$events+=($lines[$i] | ConvertFrom-Json)}
    catch{if($i -lt $lines.Count-1){throw "Journal $($journal.Name) is damaged at line $($i+1)."}}
  }
  $requested=@{}; foreach($e in @($events | Where-Object{$_.type -eq 'capability.requested'})){$requested[$e.id]=$e}
  $items=@()
  foreach($e in @($events | Where-Object{$_.type -eq 'capability.decided' -and $_.approved -eq $true})){
    $r=$requested[$e.id]
    if(-not $r -or $r.tier -ne 'sandbox'){continue}
    $items+=[pscustomobject]@{id=$e.id;kind=$r.kind;source=$r.source}
  }
  return @{journal=$journal.Name;items=$items}
}

function Install-Capability($c){
  $res=@{id=$c.id;kind=$c.kind;source=$c.source;status='failed';license=$null;reason=$null;entry=$null;at=(Get-Date).ToUniversalTime().ToString('o')}
  $dir="/home/$User/workshop/$($c.id)"
  try{
    if($c.kind -eq 'package' -and $c.source -cmatch $PackageSource){
      $pkgKind=$Matches[1];$name=$Matches[2]
      $license=Get-PackageLicense $pkgKind $name
      $res.license=$license
      if(-not (Test-License $license)){$res.reason="licence not on allowlist: $license";return $res}
      Invoke-Guest $User @('rm','-rf',$dir)
      Invoke-Guest $User @('mkdir','-p',$dir)
      if($pkgKind -eq 'npm'){
        Invoke-Guest $User @('npm','install','--ignore-scripts','--prefix',$dir,$name)
      }else{
        Invoke-Guest $User @('python3','-m','venv',$dir)
        Invoke-Guest $User @("$dir/bin/pip",'install','--only-binary=:all:',$name)
      }
      # Entry command convention shared with src/workshop.ts: npm bin link named after the unscoped package; pypi venv script.
      if($pkgKind -eq 'npm'){$res.entry=@("$dir/node_modules/.bin/$($name -replace '^@[^/]+/','')")}else{$res.entry=@("$dir/bin/$name")}
      $res.status='installed'
    }elseif($c.kind -eq 'repo' -and $c.source -cmatch $RepoSource){
      Invoke-Guest $User @('rm','-rf',$dir)
      Invoke-Guest $User @('mkdir','-p',$dir)
      Invoke-Guest $User @('git','clone','--depth','1',$c.source,"$dir/src")
      $text=(& wsl.exe -d $Distro -u $User --exec head -c 4000 "$dir/src/LICENSE" 2>$null) -join "`n"
      $license=Get-RepoLicense $text
      $res.license=$license
      if(-not (Test-License $license)){
        Invoke-Guest $User @('rm','-rf',$dir)
        $res.reason='no LICENSE file that matches the allowlist'
        return $res
      }
      $res.status='installed'
    }else{$res.reason='source does not match the sandbox rules'}
  }catch{$res.reason=$_.Exception.Message}
  return $res
}

function Show-Status{
  if(-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)){"WSL: not installed (this script does not install it)";return}
  "distro ${Distro}: $(if((Get-Distros) -contains $Distro){'exists'}else{'missing'})"
  "running: $(if((Get-Running) -contains $Distro){'yes'}else{'no'})"
  foreach($k in @($State.Keys | Where-Object{$_ -like 'step:*'} | Sort-Object)){"  $k = $($State[$k])"}
  try{
    $a=Get-Approved
    if(-not $a.journal){"approved tools: no season journal in $DataDir";return}
    "approved tools (from $($a.journal)): $($a.items.Count)"
    foreach($c in $a.items){
      $st=$State["cap:$($c.id)"]; if(-not $st){$st='not installed'}
      "  $($c.id) $($c.source): $st"
    }
  }catch{"approved tools: journal unreadable: $($_.Exception.Message)"}
  "results log: $ResultsFile"
}

if($Status){Show-Status;return}

if(-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)){throw 'WSL is not installed. This script does not install WSL; install it yourself first.'}

# 1. Download the pinned rootfs (to .part, then moved into place) and check its SHA256 every run.
if(-not (Test-Path -LiteralPath $Tarball)){
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  Invoke-WebRequest -Uri $Url -OutFile "$Tarball.part" -UseBasicParsing
  Move-Item -LiteralPath "$Tarball.part" -Destination $Tarball -Force
}
$actual=(Get-FileHash -LiteralPath $Tarball -Algorithm SHA256).Hash.ToLower()
if($actual -ne $Sha256){Remove-Item -LiteralPath $Tarball -Force;throw "SHA256 mismatch: expected $Sha256, got $actual. File removed; run again."}
Mark 'step:verify' 'done'

# 2. Import as WSL2 distro.
if(-not ((Get-Distros) -contains $Distro)){
  New-Item -ItemType Directory -Force -Path $DistroDir | Out-Null
  Invoke-Wsl @('--import',$Distro,$DistroDir,$Tarball,'--version','2')
}
Mark 'step:import' 'done'

# 3. System setup as root: no Windows drives, no interop, default user, packages, non-root user. Then restart so wsl.conf applies.
if($State['step:system'] -ne 'done'){
  Invoke-Guest 'root' @('sh','-c','apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs npm python3 python3-venv python3-pip git ca-certificates')
  Invoke-Guest 'root' @('sh','-c',"id -u $User >/dev/null 2>&1 || useradd -m -s /bin/bash $User")
  Invoke-Wsl @('--terminate',$Distro)
  Mark 'step:system' 'done'
}
# Every run: write /etc/wsl.conf (no Windows drives, no interop, default user), then restart the distro so it applies.
# The content goes base64-encoded: Windows PowerShell 5.1 drops the inner double quotes of a native argument, which
# turned the old printf version into a wsl.conf WSL could not parse ("Expected ' ' or '\n' in /etc/wsl.conf:1").
$Conf=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("[automount]`nenabled=false`n[interop]`nenabled=false`nappendWindowsPath=false`n[user]`ndefault=$User`n"))
Invoke-Guest 'root' @('sh','-c',"echo $Conf | base64 -d > /etc/wsl.conf")
Invoke-Wsl @('--terminate',$Distro)
# The distro must be isolated. test exits 0 only when the path is absent; a failure stops the install.
# Same probe as src/workshop.ts probeIsolation: exit 0 isolated, 10 a Windows drive is mounted, 11 interop is on.
# An empty /mnt/c folder left by an earlier boot is not a mount and does not count.
Invoke-Guest 'root' @('sh','-c','echo Z3JlcCAtcUUgJyAvbW50L1thLXpdICcgL3Byb2MvbW91bnRzICYmIGV4aXQgMTAKWyAtbiAiJFdTTF9JTlRFUk9QIiBdICYmIGV4aXQgMTEKYXdrICcvXlxbaW50ZXJvcFxdL3tzPTE7bmV4dH0gL15cWy97cz0wfSBzICYmIC9eZW5hYmxlZD1mYWxzZSQve2Y9MX0gRU5Ee2V4aXQgIWZ9JyAvZXRjL3dzbC5jb25mIHx8IGV4aXQgMTEKZXhpdCAwCg== | base64 -d | sh')

# 4. Install each approved capability once. A recorded 'installed' is skipped; anything else is retried.
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$approved=(Get-Approved).items
foreach($c in $approved){
  if($State["cap:$($c.id)"] -eq 'installed'){continue}
  $result=Install-Capability $c
  Add-Content -LiteralPath $ResultsFile -Value ($result | ConvertTo-Json -Compress) -Encoding UTF8
  Mark "cap:$($c.id)" $result.status
  "$($c.id) $($c.source): $($result.status)$(if($result.reason){" ($($result.reason))"})"
}
"workshop: done; run with -Status to see what is installed"
