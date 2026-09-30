@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Lycee Overture 对战平台 - 开发版启动器
echo   首次启动会自动打开一个游戏窗口
echo   关闭本窗口或按 Ctrl+C 可退出游戏
echo ============================================
call npm run dev
pause
