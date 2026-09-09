param(
    [string]$Source,
    [string]$DestinationParent,
    [string]$LaunchRecovered,
    [switch]$NoDialogs
)
$ErrorActionPreference = 'Stop'
$outputDirectory = $null
if (-not $NoDialogs) { Add-Type -AssemblyName System.Windows.Forms }

function Show-Notice([string]$Text, [bool]$Failed = $false) {
    Write-Host $Text
    if (-not $NoDialogs) {
        $icon = if ($Failed) { 'Error' } else { 'Information' }
        [void][System.Windows.Forms.MessageBox]::Show($Text, 'RisuBard 세이브 복구', 'OK', $icon)
    }
}

function Select-Directory([string]$Description, [bool]$AllowNewFolder) {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = $Description
    $dialog.ShowNewFolderButton = $AllowNewFolder
    try {
        if ($dialog.ShowDialog() -eq 'OK') { return $dialog.SelectedPath }
        return $null
    } finally { $dialog.Dispose() }
}

try {
    if ($LaunchRecovered) {
        $resultRoot = (Get-Item -LiteralPath $LaunchRecovered).FullName
        $report = Get-Content -LiteralPath (Join-Path $resultRoot 'report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $config = Get-Content -LiteralPath (Join-Path $resultRoot 'recovery-launch.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $expectedRoot = [IO.Path]::GetFullPath((Join-Path $resultRoot 'recovered'))
        if ($report.status -ne 'recovered' -or $report.sourceUnchanged -ne $true -or
            [IO.Path]::GetFullPath($config.dataRoot) -ne $expectedRoot) {
            throw '검증을 통과한 복구본이 아닙니다. report.json을 확인하세요.'
        }
        $node = $config.node
        $appRoot = $config.appRoot
        if (-not (Test-Path -LiteralPath $expectedRoot -PathType Container)) { throw '복구된 세이브 폴더를 찾을 수 없습니다.' }
        if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw '실행 파일을 찾을 수 없습니다. 핫픽스 압축을 푼 프로그램 폴더를 옮기지 마세요.' }
        if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'server/node/server.cjs') -PathType Leaf)) { throw '리스바드 프로그램 폴더를 찾을 수 없습니다.' }
        $port = if ($env:PORT) { [int]$env:PORT } else { 7777 }
        if ($port -gt 0) {
            $client = New-Object System.Net.Sockets.TcpClient
            $inUse = $false
            try { $client.Connect('127.0.0.1', $port); $inUse = $true } catch { } finally { $client.Dispose() }
            if ($inUse) { throw "포트 $port 을 사용 중입니다. 기존 리스바드 서버 창을 닫은 후 다시 실행하세요." }
        }
        $env:RISUBARD_DATA_ROOT = $expectedRoot
        $env:OPEN_BROWSER = if ($NoDialogs) { '0' } else { '1' }
        Write-Host "복구된 세이브로 실행합니다: $expectedRoot"
        Push-Location -LiteralPath $appRoot
        try {
            & $node (Join-Path $appRoot 'server/node/server.cjs')
            $serverExitCode = $LASTEXITCODE
        } finally { Pop-Location }
        if ($serverExitCode -ne 0) { throw '서버 실행이 중단되었습니다. 이 창의 오류를 확인하세요.' }
        exit 0
    }

    $appRoot = Split-Path -Parent $PSScriptRoot
    $node = Join-Path $appRoot 'bin/node.exe'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
    }
    if (-not $NoDialogs) {
        $notice = "먼저 리스바드 서버 창을 모두 닫아 주세요.`r`n`r`n1. 남은 세이브 폴더를 선택합니다.`r`n2. 복구 결과를 보관할 폴더를 선택합니다.`r`n`r`n원본은 그대로 보존하며 별도 복사본을 만듭니다. 원본 전체 크기만큼 여유 공간이 필요합니다."
        if ([System.Windows.Forms.MessageBox]::Show($notice, 'RisuBard 세이브 복구', 'OKCancel', 'Information') -ne 'OK') { exit 0 }
        $Source = Select-Directory '남은 원본 세이브 폴더를 선택하세요. characters, personas, settings 폴더가 들어 있는 위치입니다.' $false
        if (-not $Source) { exit 0 }
        $DestinationParent = Select-Directory '복구 결과를 보관할 폴더를 선택하세요. 원본 세이브 바깥의 여유 공간이 있는 위치를 고르세요.' $true
        if (-not $DestinationParent) { exit 0 }
    }
    if (-not $Source -or -not $DestinationParent) { throw '원본 세이브와 결과 보관 폴더가 필요합니다.' }
    $chosenSource = (Get-Item -LiteralPath $Source).FullName
    $destination = (Get-Item -LiteralPath $DestinationParent).FullName
    $hasEntity = $false
    foreach ($group in @(@('characters', 'character.json'), @('personas', 'persona.json'), @('modules', 'module.json'), @('prompts', 'settings.json'), @('lorebooks', 'lorebook.json'))) {
        $directory = Join-Path $chosenSource $group[0]
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
        foreach ($folder in Get-ChildItem -LiteralPath $directory -Directory) {
            if (Test-Path -LiteralPath (Join-Path $folder.FullName $group[1]) -PathType Leaf) { $hasEntity = $true; break }
        }
        if ($hasEntity) { break }
    }
    if (-not $hasEntity) { throw '이 위치에서 V2 세이브 파일을 찾지 못했습니다. characters, personas, settings 폴더가 바로 들어 있는 세이브 폴더를 선택하세요. 구형 저장소는 이 도구로 복구할 수 없습니다.' }
    $sourcePrefix = $chosenSource.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    if ($destination -eq $chosenSource -or $destination.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw '결과 보관 폴더는 원본 세이브 바깥에서 선택하세요.'
    }
    $relativeOutput = 'RisuBard-recovery-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)
    $outputDirectory = Join-Path $destination $relativeOutput
    Write-Host "원본: $chosenSource"
    Write-Host "결과: $outputDirectory"
    Write-Host '파일을 복사하고 검사하는 동안 이 창을 닫지 마세요. 데이터가 많으면 시간이 걸립니다.'
    & $node (Join-Path $PSScriptRoot 'recover-save-index.cjs') $chosenSource $outputDirectory
    $recoveryExitCode = $LASTEXITCODE
    if ($recoveryExitCode -ne 0) { throw '복구를 완료하지 못했습니다. 원본은 그대로 두고 결과 폴더의 report.json을 확인하세요.' }
    $report = Get-Content -LiteralPath (Join-Path $outputDirectory 'report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($report.status -ne 'recovered' -or $report.sourceUnchanged -ne $true) { throw '복구 검증 결과를 확인할 수 없습니다.' }
    $config = [ordered]@{ appRoot = $appRoot; node = $node; dataRoot = Join-Path $outputDirectory 'recovered' }
    $config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDirectory 'recovery-launch.json') -Encoding UTF8
    @'
@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Start-Recovered.ps1"
if errorlevel 1 pause
'@ -replace "`r?`n", "`r`n" | Set-Content -LiteralPath (Join-Path $outputDirectory 'Start-Recovered-RisuBard.bat') -Encoding ASCII
    @'
$ErrorActionPreference = 'Stop'
try {
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'recovery-launch.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    & (Join-Path $config.appRoot 'scripts/recover-save.ps1') -LaunchRecovered $PSScriptRoot
} catch {
    Write-Host $_.Exception.Message
    exit 1
}
'@ | Set-Content -LiteralPath (Join-Path $outputDirectory 'Start-Recovered.ps1') -Encoding UTF8
    $instructions = "복구가 완료되었습니다.`r`n`r`n이 폴더의 Start-Recovered-RisuBard.bat을 더블클릭하세요.`r`n복구본으로 리스바드가 열립니다. 원본 세이브를 옮기거나 덮어쓸 필요가 없습니다.`r`n`r`n캐릭터와 대화, 이미지, 프롬프트·페르소나 선택을 확인하세요.`r`n이후에도 복구본을 사용하려면 같은 BAT로 실행하세요.`r`n프로그램 폴더와 이 복구 결과 폴더를 옮기지 말고, 원본도 보존하세요."
    $instructions | Set-Content -LiteralPath (Join-Path $outputDirectory 'READ-ME.txt') -Encoding UTF8
    Show-Notice ($instructions + "`r`n`r`n결과 위치: $outputDirectory")
    if (-not $NoDialogs) { Invoke-Item -LiteralPath $outputDirectory }
    exit 0
} catch {
    $message = $_.Exception.Message
    if ($outputDirectory -and (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
        $message += "`r`n`r`n결과 위치: $outputDirectory"
        $message | Set-Content -LiteralPath (Join-Path $outputDirectory 'RECOVERY-ERROR.txt') -Encoding UTF8
        if (-not $NoDialogs) { Invoke-Item -LiteralPath $outputDirectory }
    }
    Show-Notice $message $true
    exit 1
}
