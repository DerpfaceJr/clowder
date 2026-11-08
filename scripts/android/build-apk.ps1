# Builds dist-android\Clowder.apk from android\ with the SDK tools that ship inside Unity's Android module.
# No Gradle, no downloads. Safe to re-run: every build starts clean and installs over the last one.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$src = Join-Path $repo 'android'
$dist = Join-Path $repo 'dist-android'
$work = Join-Path $dist 'work'
$out = Join-Path $dist 'Clowder.apk'

# Signing key and version counter live outside the repo and are never committed.
$secrets = Join-Path $env:APPDATA 'Clowder\android'
$keystore = Join-Path $secrets 'clowder-release.keystore'
$passFile = Join-Path $secrets 'clowder-release.password'
$counterFile = Join-Path $secrets 'version-code.txt'
$alias = 'clowder'
$minSdk = 26
$targetSdk = 34

function Fail([string]$text) { throw "build-apk: $text" }

function Invoke-Tool([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { Fail "$(Split-Path $exe -Leaf) exited with code $LASTEXITCODE" }
}

# --- SDK and JDK ---------------------------------------------------------------------------------
$sdk = $env:ANDROID_HOME
if (-not $sdk -or -not (Test-Path $sdk)) {
    $sdk = 'C:\Program Files\Unity\Hub\Editor\6000.6.0f1\Editor\Data\PlaybackEngines\AndroidPlayer\SDK'
}
if (-not (Test-Path $sdk)) { Fail 'Android SDK not found. Set ANDROID_HOME.' }

$buildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
    Where-Object { $_.Name -match '^\d+(\.\d+)+$' } |
    Sort-Object { [version]$_.Name } | Select-Object -Last 1
if (-not $buildTools) { Fail "No build-tools under $sdk" }
$bt = $buildTools.FullName

$platform = @('android-36', 'android-34') |
    Where-Object { Test-Path (Join-Path $sdk "platforms\$_\android.jar") } | Select-Object -First 1
if (-not $platform) { Fail "Neither android-36 nor android-34 is installed under $sdk" }
$androidJar = Join-Path $sdk "platforms\$platform\android.jar"

$jdkBin = Join-Path (Split-Path $sdk -Parent) 'OpenJDK\bin'
if (-not (Test-Path (Join-Path $jdkBin 'javac.exe'))) {
    $javacOnPath = Get-Command javac.exe -ErrorAction SilentlyContinue
    if (-not $javacOnPath) { Fail 'No JDK found: expected Unity OpenJDK next to the SDK, or javac on PATH.' }
    $jdkBin = Split-Path $javacOnPath.Source
}
$java = Join-Path $jdkBin 'java.exe'
$javac = Join-Path $jdkBin 'javac.exe'
$keytool = Join-Path $jdkBin 'keytool.exe'
$aapt2 = Join-Path $bt 'aapt2.exe'
$aapt = Join-Path $bt 'aapt.exe'
$zipalign = Join-Path $bt 'zipalign.exe'
$d8Jar = Join-Path $bt 'lib\d8.jar'
$apksignerJar = Join-Path $bt 'lib\apksigner.jar'

# --- Version -------------------------------------------------------------------------------------
$versionName = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$gitCount = 0
$count = & git -C $repo rev-list --count HEAD 2>$null
if ($LASTEXITCODE -eq 0 -and $count) { $gitCount = [int]$count }
$counter = 0
if (Test-Path $counterFile) { $counter = [int]((Get-Content $counterFile -Raw).Trim()) }
$versionCode = [Math]::Max($counter + 1, $gitCount)

# --- Signing key (created once; re-used by every later build) -------------------------------------
New-Item -ItemType Directory -Force -Path $secrets | Out-Null
if (-not (Test-Path $keystore)) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [IO.File]::WriteAllText($passFile, [Convert]::ToBase64String($bytes))
    Invoke-Tool $keytool @('-genkeypair', '-keystore', $keystore, '-storetype', 'PKCS12', '-alias', $alias,
        '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Clowder, O=derpfacejr',
        '-storepass:file', $passFile, '-keypass:file', $passFile)
} elseif (-not (Test-Path $passFile)) {
    Fail "Keystore exists but its password file is missing: $passFile. Restore it; a new key would break updates."
}

# --- Build -----------------------------------------------------------------------------------------
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
$gen = Join-Path $work 'gen'
$classes = Join-Path $work 'classes'
$dex = Join-Path $work 'dex'
New-Item -ItemType Directory -Force -Path $gen, $classes, $dex | Out-Null
$resZip = Join-Path $work 'res.zip'
$base = Join-Path $work 'base.apk'
$app = Join-Path $work 'app.apk'
$aligned = Join-Path $work 'aligned.apk'

Invoke-Tool $aapt2 @('compile', '--dir', (Join-Path $src 'res'), '-o', $resZip)
Invoke-Tool $aapt2 @('link', '-I', $androidJar, '--manifest', (Join-Path $src 'AndroidManifest.xml'),
    '--java', $gen, '--min-sdk-version', "$minSdk", '--target-sdk-version', "$targetSdk",
    '--version-code', "$versionCode", '--version-name', $versionName, '-o', $base, $resZip)

$sources = @(Get-ChildItem (Join-Path $src 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$sources += @(Get-ChildItem $gen -Recurse -Filter R.java | ForEach-Object { $_.FullName })
Invoke-Tool $javac (@('--release', '11', '-encoding', 'UTF-8', '-Xlint:-options', '-classpath', $androidJar,
    '-d', $classes) + $sources)

$classFiles = @(Get-ChildItem $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName })
Invoke-Tool $java (@('-cp', $d8Jar, 'com.android.tools.r8.D8', '--release', '--min-api', "$minSdk",
    '--lib', $androidJar, '--output', $dex) + $classFiles)

Copy-Item $base $app
Push-Location $dex
try { Invoke-Tool $aapt @('add', $app, 'classes.dex') } finally { Pop-Location }

Invoke-Tool $zipalign @('-p', '-f', '4', $app, $aligned)
Invoke-Tool $zipalign @('-c', '-p', '4', $aligned)

# --- Sign and publish ------------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $out) { Remove-Item $out -Force }
Invoke-Tool $java @('-jar', $apksignerJar, 'sign', '--ks', $keystore, '--ks-key-alias', $alias,
    '--ks-pass', "file:$passFile", '--out', $out, $aligned)
Invoke-Tool $java @('-jar', $apksignerJar, 'verify', $out)

[IO.File]::WriteAllText($counterFile, "$versionCode")
Remove-Item $work -Recurse -Force
Write-Output ("Built {0} ({1:N0} bytes, versionCode {2}, versionName {3})" -f $out, (Get-Item $out).Length, $versionCode, $versionName)
