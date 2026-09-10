@echo off
chcp 65001 >nul
echo ============================================
echo  Workbench share port firewall fix
echo  Allow inbound TCP 17500 (all profiles)
echo ============================================
echo.

netsh advfirewall firewall delete rule name="Workbench Share 17500" >nul 2>&1
netsh advfirewall firewall add rule name="Workbench Share 17500" dir=in action=allow protocol=TCP localport=17500 profile=any

echo.
echo Done. Port 17500 is now allowed.
echo Share link: http://192.168.1.18:17500/?token=ASSISTANT_TOKEN
echo.
pause
