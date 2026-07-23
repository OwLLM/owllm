import base64
script = r"""Write-Host "=== RDP Settings ==="
$ts = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction SilentlyContinue
Write-Host "fDenyTSConnections = $($ts.fDenyTSConnections)"
$rdp = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -ErrorAction SilentlyContinue
Write-Host "PortNumber = $($rdp.PortNumber)"
Write-Host "UserAuthentication (NLA) = $($rdp.UserAuthentication)"
Write-Host "SecurityLayer = $($rdp.SecurityLayer)"
Write-Host "MinEncryptionLevel = $($rdp.MinEncryptionLevel)"
Write-Host ""
Write-Host "=== Firewall rules containing 3389/3390 ==="
Get-NetFirewallRule | Where-Object { $_.DisplayName -match 'Remote Desktop|3389|3390' } | Format-Table DisplayName, Enabled, Direction, Action, Profile -AutoSize
Write-Host ""
Write-Host "=== Netstat RDP (3389/3390) ==="
& netstat -ano | Select-String ':3389|:3390'
Write-Host ""
Write-Host "=== RDP sessions ==="
& qwinsta
Write-Host ""
Write-Host "=== Recent failed logons (Event 4625, last 20) ==="
$events = Get-WinEvent -FilterHashtable @{LogName='Security'; ID=4625} -MaxEvents 20 -ErrorAction SilentlyContinue
$events | ForEach-Object { $ip = $_.Properties[19].Value; $user = $_.Properties[5].Value; $status = $_.Properties[7].Value; "$($_.TimeCreated) user=$user ip=$ip status=$status" }
Write-Host ""
Write-Host "=== Recent successful logons (Event 4624, last 10 type 10) ==="
Get-WinEvent -FilterHashtable @{LogName='Security'; ID=4624} -MaxEvents 50 -ErrorAction SilentlyContinue | Where-Object { $_.Properties[8].Value -eq 10 } | ForEach-Object { "$($_.TimeCreated) user=$($_.Properties[5].Value) ip=$($_.Properties[18].Value) type=$($_.Properties[8].Value)" }"""
with open('rdp_diag_b64.txt','w') as f:
    f.write(base64.b64encode(script.encode('utf-16le')).decode())
