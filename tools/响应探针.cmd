@echo off
rem 本文件以 GBK(cp936) 保存，不要 chcp（原因见 退出并安装补丁.cmd 顶部注释）。
setlocal
cd /d "%~dp0.."

set PY=python

echo ============================================
echo   zcode-lagfix 外部响应探针
echo ============================================
echo.
echo 右下角会出现一个置顶小窗（左键拖动，右键关闭）。
echo 只向 ZCode 主窗口发送 WM_NULL 空消息并计时，
echo 不注入、不改 app.asar、不需要退出 ZCode。
echo.
echo 判读：P50 ^< 20ms 流畅 / P95 20~80ms 轻微掉帧 /
echo       P95 ^> 80ms 明显卡顿 / 单次 ^> 500ms 卡死级别。
echo.

"%PY%" tools\lagfix-probe.py --overlay
if errorlevel 1 (
    echo.
    echo [!] 探针退出（错误码 %errorlevel%）。
    echo     若提示没有 tkinter，请改用文本模式：
    echo     python tools\lagfix-probe.py
    echo.
    pause
)
