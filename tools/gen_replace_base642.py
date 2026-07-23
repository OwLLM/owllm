import base64
s = r"(Get-Content 'C:\Users\mc\Desktop\fix-rdp-admin.bat') -replace '\^&', '&' | Set-Content 'C:\Users\mc\Desktop\fix-rdp-admin.bat'"
print(base64.b64encode(s.encode('utf-16le')).decode())
