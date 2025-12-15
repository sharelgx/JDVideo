#!/bin/bash

echo "正在打包Chrome扩展插件..."

# 设置输出文件名
OUTPUT_FILE="JDdownload.zip"

# 删除旧压缩包
if [ -f "$OUTPUT_FILE" ]; then
    rm "$OUTPUT_FILE"
fi

# 进入extension目录并打包
cd extension
zip -r "../$OUTPUT_FILE" . -x "*.DS_Store" "*__MACOSX*"
cd ..

if [ -f "$OUTPUT_FILE" ]; then
    echo ""
    echo "✓ 打包成功！"
    echo "文件名: $OUTPUT_FILE"
    echo "位置: $(pwd)/$OUTPUT_FILE"
    echo ""
    echo "安装说明:"
    echo "1. 解压 $OUTPUT_FILE"
    echo "2. 打开 Chrome 扩展管理页: chrome://extensions/"
    echo "3. 开启\"开发者模式\""
    echo "4. 点击\"加载已解压的扩展程序\""
    echo "5. 选择解压后的 extension 文件夹"
else
    echo "✗ 打包失败，请检查 zip 命令是否可用"
fi

