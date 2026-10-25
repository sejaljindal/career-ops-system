$total = 244
$completed = 0

Write-Host "Starting batch processing for $total URLs with parallel 4..."

while ($completed -lt $total) {
    Write-Host "Running batch of 4..."
    
    # Run batch runner with limit 4, and let it sleep 300s (5m) if rate limited
    $process = Start-Process -FilePath "C:\Program Files\Git\bin\bash.exe" -ArgumentList "batch/batch-runner.sh --parallel 4 --limit 4 --rate-limit-sleep 300" -NoNewWindow -Wait -PassThru
    
    if ($process.ExitCode -ne 0) {
        Write-Host "Batch runner exited with code $($process.ExitCode). Continuing..."
    }

    # Count progress
    if (Test-Path "batch/batch-state.tsv") {
        $state = Get-Content "batch/batch-state.tsv"
        $completed = ($state | Where-Object { $_ -match "`tcompleted`t" -or $_ -match "`tfailed`t" -or $_ -match "`tskipped`t" -or $_ -match "`tdiscarded`t" }).Count
    }
    
    Write-Host "Progress: $completed / $total completed."
    
    if ($completed -ge $total) {
        break
    }
}

Write-Host "All batches completed."
