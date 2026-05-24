@echo off
cd /d "D:\Dadda\Desktop\playwright\playwright-cli"
pm2 resurrect
timeout /t 3 /nobreak >nul
pm2 start ecosystem.config.js --no-daemon-mode 2>nul
pm2 save
