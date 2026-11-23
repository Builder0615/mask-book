# mask-read

一个在 VS Code 底部 `Status Bar` 中显示当前阅读内容的本地与在线阅读插件。

## 当前支持

- EPUB：读取 `container.xml`、OPF、spine，并解析 EPUB 2 NCX 或 EPUB 3 nav 目录。
- FB2：读取书名、`section` 和章节标题。
- PDF：提取文字型 PDF 的文本；扫描版 PDF 需要 OCR，图片和复杂排版不会还原。
- DOCX / ODT：读取文档中的段落文本。
- TXT / TEXT / NOVEL / LOG：支持章节识别、UTF-8、UTF-16、GB18030/GBK 自动识别。
- Markdown / RST / AsciiDoc / Org：按纯文本阅读，保留原始标记。
- HTML / HTM / XHTML / XML：提取正文文本并识别章节标题。
- RTF、SRT、VTT、ASS、SSA：按文本阅读，适合快速查看文字内容。
- Legado 书源：导入书源 JSON 后搜索在线书籍，支持相对 URL、请求头、GET/POST、CSS、XPath、JSONPath、模板拼接/回退和 `##` 正则清洗。

MOBI、AZW 等需要专用二进制解码的格式暂未纳入当前版本。

## 使用方式

1. 打开左侧的 `mask-read`，其中包含“书架”“章节目录”和“书源管理”面板。
2. 点击书架标题栏右侧的 `+` 选择书籍文件或目录，识别成功后会自动加入书架并显示章节目录。目录会递归识别其中支持的文件。
3. 单击书架中的文件即可切换；鼠标移到文件上点击右侧 `×` 即可移除书架记录，不会删除磁盘文件。
4. 点击章节目录会切换到该章节第一行。
5. 当前章节的当前行只在打开书籍后显示于 VS Code 底部 Status Bar；默认使用 Alt 组合键控制阅读，快捷键修饰键可以在扩展设置中分别自定义。隐藏阅读行时会保留书本图标。

6. “书源管理”面板按“书源”和“订阅源”分组显示；每项前有复选框，面板顶部的“全选”复选框可全选/清空，也可以按住 Ctrl/Cmd 多选，使用标题栏的删除选中源；单项还支持启用/停用书源、移除书源、刷新/重命名/删除订阅源。

在线书籍与书源：

1. 在书架标题栏点击“添加”按钮，选择“本地”“导入书源”或“导入订阅源”。选择书源或订阅源后才会弹出输入框：书源支持输入 JSON 的 URL、本地文件路径或直接粘贴 JSON；订阅源需要输入返回书源 JSON 的 HTTP(S) 地址。可以使用 [aoaostar/legado](https://github.com/aoaostar/legado) “书源”栏目中的直链，不能直接输入 GitHub 仓库页面地址或“订阅源”栏目中的文章/资讯源链接。
2. 订阅源会保存名称和地址，支持启动时刷新、手动刷新、重命名和删除；这些操作可直接在“书源管理”面板中完成。
3. 点击搜索按钮，或运行 `mask-read: 搜索在线书籍`，输入书名或作者。
4. 选择结果后会读取详情和目录；在线正文按章节首次打开时加载，在线书籍会保存在书架中。

默认一次搜索最多请求 12 个已启用文本书源，可在设置中调整 `maskRead.onlineSearchMaxSources`；请求超时可通过 `maskRead.onlineRequestTimeoutMs` 调整。

当前兼容的是 Legado 书源的声明式规则。书源中的任意 JavaScript、登录 UI、CookieJar、WebView JS 和音频源不会在扩展中执行；这类书源可能无法搜索或读取完整内容。

只有明确需要打包或发布时，才在 GitHub Actions 中手动运行 `Build and Release` workflow，并输入与 `package.json` 版本一致的标签（例如 `v0.2.0`）。普通提交和推送不会触发构建或创建 Release。

如果在 GitHub 仓库中配置名为 `VSCE_PAT` 的 Actions Secret，手动运行 `Publish to VS Code Marketplace` workflow 时会自动发布到 VS Code 插件市场；不配置 PAT 时，也可以直接在 Marketplace Publisher 管理页上传 VSIX。该 workflow 也不会被普通提交或标签自动触发。

快捷键：

打开书籍后可使用以下组合键：

- `Alt + ←`：上一行。
- `Alt + →`：下一行。
- `Alt + ↑`：上一章。
- `Alt + ↓`：下一章。
- `Alt + Space`：显示或隐藏 Status Bar 阅读行。

Alt + 上下键切换章节时会定位到目标章节开头；Alt + 左右键翻行到章节边界时会沿用翻行逻辑，左键进入上一章末尾，右键进入下一章开头。

快捷键设置：

- `maskRead.shortcut.lineModifier`：翻行快捷键的修饰键，基础按键为 `←/→`。
- `maskRead.shortcut.chapterModifier`：换章快捷键的修饰键，基础按键为 `↑/↓`。
- `maskRead.shortcut.toggleModifier`：显示/隐藏快捷键的修饰键，基础按键为 `Space`。

三个设置默认都是 `Alt`，也可以选择 `Ctrl/Cmd`、`Shift` 或多个修饰键组合。修改后状态栏提示和快捷键会同步更新。

Status Bar 没有固定宽度，因此超长原文行会按 `maskRead.statusBarMaxLength` 分成多个显示段，使用翻行快捷键即可继续查看，不会省略内容，默认每段最多显示 72 个字符。TXT 编码可以在设置中调整：`maskRead.textEncoding`，默认值为 `auto`；如果中文 TXT 显示乱码，可以手动选择 `gb18030`。
