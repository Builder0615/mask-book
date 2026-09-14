# mask-book

一个把当前阅读行隐蔽显示在 VS Code 底部 `Status Bar` 中的本地阅读插件。

## 当前支持

- EPUB：读取 `container.xml`、OPF、spine，并解析 EPUB 2 NCX 或 EPUB 3 nav 目录。
- FB2：读取书名、`section` 和章节标题。
- PDF：提取文字型 PDF 的文本；扫描版 PDF 需要 OCR，图片和复杂排版不会还原。
- DOCX / ODT：读取文档中的段落文本。
- TXT / TEXT / NOVEL / LOG：支持章节识别、UTF-8、UTF-16、GB18030/GBK 自动识别。
- Markdown / RST / AsciiDoc / Org：按纯文本阅读，保留原始标记。
- HTML / HTM / XHTML / XML：提取正文文本并识别章节标题。
- RTF、SRT、VTT、ASS、SSA：按文本阅读，适合快速查看文字内容。

MOBI、AZW 等需要专用二进制解码的格式暂未纳入当前版本。

## 使用方式

1. 打开左侧的 `mask-book`，其中只有“书架”和“章节目录”。
2. 点击书架标题栏右侧的 `+` 选择书籍文件或目录，识别成功后会自动加入书架并显示章节目录。目录会递归识别其中支持的文件。
3. 单击书架中的文件即可切换；鼠标移到文件上点击右侧 `×` 即可移除书架记录，不会删除磁盘文件。
4. 点击章节目录会切换到该章节第一行。
5. 当前章节的当前行只在打开书籍后显示于 VS Code 底部 Status Bar；状态栏按钮和快捷键负责显示/隐藏。

发布新版本时，推送一个与 `package.json` 版本对应的标签（例如 `v0.1.0`），GitHub Actions 会自动运行测试、构建 VSIX 并创建 GitHub Release。

快捷键：

- `Ctrl/Cmd + ↑`：上一行。
- `Ctrl/Cmd + ↓`：下一行。
- `Ctrl/Cmd + ←`：上一章。
- `Ctrl/Cmd + →`：下一章。
- `Ctrl + M`（macOS：`Command + M`）：显示或隐藏 Status Bar 阅读行。

Status Bar 没有固定宽度，因此超长行会按 `consoleReader.statusBarMaxLength` 截断并显示省略号，默认最多显示 72 个字符。TXT 编码可以在设置中调整：`consoleReader.textEncoding`，默认值为 `auto`；如果中文 TXT 显示乱码，可以手动选择 `gb18030`。
