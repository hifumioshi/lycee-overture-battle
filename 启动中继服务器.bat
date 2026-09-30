@echo off
chcp 65001 >nul
title Lycee 中继服务器（本地测试 / 服务器部署）
cd /d "%~dp0"
echo ============================================
echo   Lycee Overture 中继服务器
echo   端口：9600（可改为 node server\index.js 其他端口）
echo   保持本窗口开启；关闭窗口 = 停止服务器
echo ============================================
node server\index.js 9600
pause
