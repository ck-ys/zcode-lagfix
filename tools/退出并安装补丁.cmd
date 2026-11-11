@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  本文件必须以 GBK(cp936) 保存，且不要在开头 chcp。
rem  cmd.exe 按"当前代码页"解释批处理字节：若文件是 UTF-8 再 chcp 65001，
rem  chcp 之前已读入的行会按 936 解释成乱码（用户实测踩到）。
rem  中文 Windows 控制台默认就是 936，Python 侧往真控制台输出走
rem  WriteConsoleW，不受代码页影响，所以两边都不需要 chcp。
rem ============================================================

set PY=python
set FINALIZE=D:\Git\git-github\zcode-lagfix\plugins\zcode-lagfix\patch_install.py
set ASAR=E:\Program Files\ZCode\resources\app.asar
set ZCODE_EXE=E:\Program Files\ZCode\ZCode.exe

echo ============================================
echo   zcode-lagfix 一键安装补丁
echo ============================================
echo.
echo 本脚本会：
echo   1. 强制关闭所有 ZCode 进程（当前对话会中断）
echo   2. 把已排好的补丁包替换进 app.asar
echo   3. 重新启动 ZCode
echo.
echo 请确认你手上没有正在跑的重要任务！
echo.
pause

set RC=1
for /L %%i in (1,1,4) do (
    if !RC! NEQ 0 (
        echo.
        echo [尝试 %%i/4] 关闭 ZCode 并替换 ...
        taskkill /IM ZCode.exe /F >nul 2>&1
        taskkill /IM zcode-runtime-host.exe /F >nul 2>&1
        rem 托盘进程/自动拉起可能残留，多等一会儿再动文件
        timeout /t 4 /nobreak >nul
        "%PY%" "%FINALIZE%" finalize --asar "%ASAR%"
        set RC=!ERRORLEVEL!
        if !RC! NEQ 0 timeout /t 5 /nobreak >nul
    )
)

echo.
if not "%RC%"=="0" (
    echo [!] 替换未成功（退出码 %RC%）。
    echo     若提示 busy：说明还有 ZCode 进程在跑，打开任务管理器
    echo     结束所有 ZCode.exe / zcode-runtime-host.exe 后再运行一次。
    echo     若提示 failed：把上文输出发给开发者，不要反复重试。
    echo.
    pause
    exit /b 1
)

echo [完成] 重新启动 ZCode ...
start "" "%ZCODE_EXE%"
timeout /t 2 /nobreak >nul

echo.
echo ============================================
echo   完成！ZCode 正在启动。
echo   重开后聊天区右上角会出现 lag 角标，
echo   也可以输入 /lagfix 查看完整报告。
echo ============================================
timeout /t 8 /nobreak >nul
exit /b 0
