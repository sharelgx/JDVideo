@echo off
chcp 65001 >nul
echo 正在整理项目文件夹...

REM 创建misc文件夹存放非项目文件
if not exist "misc" mkdir misc
if not exist "misc\cache" mkdir misc\cache
if not exist "misc\temp" mkdir misc\temp

REM 移动Python缓存文件
if exist "__pycache__" (
    echo 移动 __pycache__ 到 misc\cache\...
    move "__pycache__" "misc\cache\" >nul 2>&1
)

REM 移动意外创建的文件
if exist "et --hard v1.12-deliverable" (
    echo 移动意外文件到 misc\temp\...
    move "et --hard v1.12-deliverable" "misc\temp\" >nul 2>&1
)

if exist "的直接下载，支持记住用户选择的目录" (
    echo 移动意外文件到 misc\temp\...
    move "的直接下载，支持记住用户选择的目录" "misc\temp\" >nul 2>&1
)

REM 查找并移动根目录下的.pyc文件
for %%f in (*.pyc) do (
    echo 移动 %%f 到 misc\cache\...
    move "%%f" "misc\cache\" >nul 2>&1
)

echo.
echo 整理完成！
echo 非项目文件已移动到 misc 文件夹
pause




