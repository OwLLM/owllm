import base64
s = r'''$bat = @'
@echo off
echo === RDP fix log === ^> "%USERPROFILE%\rdp-fix.log"
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" /v PortNumber /t REG_DWORD /d 3390 /f ^>^> "%USERPROFILE%\rdp-fix.log" 2^>^&1
net stop TermService ^>^> "%USERPROFILE%\rdp-fix.log" 2^>^&1
net start TermService ^>^> "%USERPROFILE%\rdp-fix.log" 2^>^&1
netsh advfirewall firewall add rule name="RDP 3390" dir=in action=allow protocol=TCP localport=3390 ^>^> "%USERPROFILE%\rdp-fix.log" 2^>^&1
echo Done ^>^> "%USERPROFILE%\rdp-fix.log"
pause
'@
Set-Content -Path 'C:\Users\mc\Desktop\fix-rdp-admin.bat' -Value $bat
'''
with open('rdp_fix_b64.txt','w') as f:
    f.write(base64.b64encode(s.encode('utf-16le')).decode())
