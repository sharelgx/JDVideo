#!/bin/bash

echo "正在整理项目文件夹..."

# 创建misc文件夹存放非项目文件
mkdir -p misc/cache
mkdir -p misc/temp

# 移动Python缓存文件
if [ -d "__pycache__" ]; then
    echo "移动 __pycache__ 到 misc/cache/..."
    mv "__pycache__" "misc/cache/" 2>/dev/null
fi

# 移动意外创建的文件
if [ -f "et --hard v1.12-deliverable" ]; then
    echo "移动意外文件到 misc/temp/..."
    mv "et --hard v1.12-deliverable" "misc/temp/" 2>/dev/null
fi

if [ -f "的直接下载，支持记住用户选择的目录" ]; then
    echo "移动意外文件到 misc/temp/..."
    mv "的直接下载，支持记住用户选择的目录" "misc/temp/" 2>/dev/null
fi

# 查找并移动根目录下的.pyc文件
find . -maxdepth 1 -name "*.pyc" -type f -exec mv {} misc/cache/ \; 2>/dev/null

echo ""
echo "整理完成！"
echo "非项目文件已移动到 misc 文件夹"




