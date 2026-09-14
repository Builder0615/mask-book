import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { BookShelfProvider } from './bookshelf';
import { parseBook } from './parsers';
import { Book, Chapter, SUPPORTED_EXTENSIONS, TextEncoding } from './types';

const LAST_FILE_KEY = 'consoleReader.lastFilePath';
const RECENT_FILES_KEY = 'consoleReader.recentFilePaths';
const CHAPTER_PREFIX = 'consoleReader.chapter.';

interface ReadingPosition {
  chapter: number;
  line: number;
}

export class ChapterItem extends vscode.TreeItem {
  public readonly chapterId: string;

  public constructor(chapter: Chapter, index: number) {
    super(`${index + 1}. ${chapter.title}`, vscode.TreeItemCollapsibleState.None);
    this.chapterId = chapter.id;
    this.id = chapter.id;
    this.tooltip = chapter.title;
    this.description = chapter.source;
    this.contextValue = 'consoleReader.chapter';
    this.iconPath = new vscode.ThemeIcon('book');
    this.command = {
      command: 'consoleReader.jumpToChapter',
      title: '阅读章节',
      arguments: [chapter.id]
    };
  }
}

export class ChapterTreeProvider implements vscode.TreeDataProvider<ChapterItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ChapterItem[] | undefined>();
  private chapters: Chapter[] = [];

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public setChapters(chapters: Chapter[]): void {
    this.chapters = chapters;
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(element: ChapterItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ChapterItem): vscode.ProviderResult<ChapterItem[]> {
    if (element) {
      return [];
    }
    return this.chapters.map((chapter, index) => new ChapterItem(chapter, index));
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

export class ReaderController implements vscode.Disposable {
  public readonly chapterTree = new ChapterTreeProvider();
  public readonly bookShelf: BookShelfProvider;

  private book: Book | undefined;
  private currentChapterIndex = 0;
  private currentLine = 0;
  private totalLines = 1;
  private lineHidden = false;
  private loadSequence = 0;
  private positionSaveTimer: NodeJS.Timeout | undefined;
  private readonly contentStatusBarItem: vscode.StatusBarItem;
  private readonly controlStatusBarItem: vscode.StatusBarItem;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.bookShelf = new BookShelfProvider({
      removeFromShelf: filePath => void this.removeFromShelf(filePath)
    });
    this.contentStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.controlStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
    this.controlStatusBarItem.command = 'consoleReader.toggleLine';
    this.updateStatusBar();
    void this.refreshBookShelf();
  }

  public get hasBook(): boolean {
    return Boolean(this.book);
  }

  public async restoreLastBook(): Promise<void> {
    const lastFilePath = this.context.globalState.get<string>(LAST_FILE_KEY);
    if (!lastFilePath) {
      return;
    }
    try {
      await fs.access(lastFilePath);
      await this.openPath(lastFilePath, true);
    } catch {
      await this.context.globalState.update(LAST_FILE_KEY, undefined);
    }
  }

  public async addBook(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: '添加到书架',
      title: '添加书籍到书架',
      filters: {
        '支持的书籍格式': [...SUPPORTED_EXTENSIONS]
      }
    });
    if (!uris) {
      return;
    }
    await this.openSelectedPaths(uris.map(uri => uri.fsPath));
  }

  public async openPath(filePath: string, showLine: boolean): Promise<void> {
    const sequence = ++this.loadSequence;
    const absolutePath = path.resolve(filePath);
    try {
      await fs.access(absolutePath);
      const textEncoding = vscode.workspace.getConfiguration('consoleReader').get<TextEncoding>('textEncoding', 'auto');
      const book = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在解析 ${path.basename(absolutePath)}`,
          cancellable: false
        },
        () => parseBook(absolutePath, textEncoding)
      );

      if (sequence !== this.loadSequence) {
        return;
      }

      this.book = book;
      const position = this.restorePosition(book);
      this.currentChapterIndex = position.chapter;
      this.currentLine = position.line;
      this.totalLines = Math.max(1, book.chapters[this.currentChapterIndex]?.content.split('\n').length ?? 1);
      this.currentLine = Math.min(this.currentLine, this.totalLines - 1);
      this.chapterTree.setChapters(book.chapters);
      this.lineHidden = !showLine;
      await this.rememberBook(absolutePath);
      await this.saveCurrentPosition();
      await vscode.commands.executeCommand('setContext', 'consoleReader.hasBook', true);
      this.updateStatusBar();
      vscode.window.setStatusBarMessage(
        `已打开《${book.title}》 · ${book.chapters.length} 个章节`,
        3000
      );
    } catch (error) {
      if (sequence !== this.loadSequence) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`mask-book 打开失败：${message}`);
    }
  }

  public jumpToChapter(chapterId: string): void {
    if (!this.book) {
      return;
    }
    const index = this.book.chapters.findIndex(chapter => chapter.id === chapterId);
    if (index < 0) {
      return;
    }
    this.currentChapterIndex = index;
    this.currentLine = 0;
    this.totalLines = Math.max(1, this.book.chapters[index].content.split('\n').length);
    this.lineHidden = false;
    this.scheduleSavePosition();
    this.updateStatusBar();
  }

  public moveLine(delta: number): void {
    if (!this.book) {
      return;
    }
    const chapter = this.book.chapters[this.currentChapterIndex];
    const lineCount = Math.max(1, chapter?.content.split('\n').length ?? 1);
    this.currentLine = Math.max(0, Math.min(lineCount - 1, this.currentLine + delta));
    this.totalLines = lineCount;
    this.scheduleSavePosition();
    this.updateStatusBar();
  }

  public nextChapter(): void {
    if (!this.book) {
      return;
    }
    const nextIndex = Math.min(this.book.chapters.length - 1, this.currentChapterIndex + 1);
    this.jumpToChapter(this.book.chapters[nextIndex].id);
  }

  public previousChapter(): void {
    if (!this.book) {
      return;
    }
    const previousIndex = Math.max(0, this.currentChapterIndex - 1);
    this.jumpToChapter(this.book.chapters[previousIndex].id);
  }

  public toggleLine(): void {
    if (!this.book) {
      return;
    }
    if (this.lineHidden) {
      this.lineHidden = false;
    } else {
      this.lineHidden = true;
    }
    this.updateStatusBar();
  }

  public closeBook(): void {
    this.book = undefined;
    this.currentChapterIndex = 0;
    this.chapterTree.setChapters([]);
    this.currentLine = 0;
    this.totalLines = 1;
    this.lineHidden = false;
    void vscode.commands.executeCommand('setContext', 'consoleReader.hasBook', false);
    this.updateStatusBar();
  }

  public async removeFromShelf(filePath: string): Promise<void> {
    const paths = await this.getRecentPaths();
    const remaining = paths.filter(item => item !== filePath);
    await this.context.globalState.update(RECENT_FILES_KEY, remaining);
    if (this.context.globalState.get<string>(LAST_FILE_KEY) === filePath) {
      await this.context.globalState.update(LAST_FILE_KEY, remaining[0]);
    }
    this.bookShelf.setPaths(remaining);
  }

  public async openSelectedPaths(values: string[]): Promise<void> {
    const paths = [...new Set(values.map(value => value.trim()).filter(Boolean))];
    const supportedPaths = await this.findSupportedPaths(paths);
    if (supportedPaths.length === 0) {
      vscode.window.showWarningMessage('请选择 EPUB、FB2、PDF、DOCX、ODT、TXT、Markdown、HTML、XML、RTF 或字幕文件。');
      return;
    }
    if (supportedPaths.length > 1) {
      await this.rememberBooks(supportedPaths);
      void vscode.window.showInformationMessage(`检测到 ${supportedPaths.length} 个支持的文件，已打开第一个。`);
    }
    await this.openPath(supportedPaths[0], true);
  }

  public dispose(): void {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
    }
    this.chapterTree.dispose();
    this.bookShelf.dispose();
    this.contentStatusBarItem.dispose();
    this.controlStatusBarItem.dispose();
  }

  private restorePosition(book: Book): ReadingPosition {
    const saved = this.context.globalState.get<ReadingPosition | number>(`${CHAPTER_PREFIX}${book.filePath}`);
    const chapter = typeof saved === 'number' ? saved : saved?.chapter ?? 0;
    const line = typeof saved === 'number' ? 0 : saved?.line ?? 0;
    return {
      chapter: Math.max(0, Math.min(chapter, Math.max(0, book.chapters.length - 1))),
      line: Math.max(0, line)
    };
  }

  private scheduleSavePosition(): void {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
    }
    this.positionSaveTimer = setTimeout(() => {
      void this.saveCurrentPosition();
    }, 250);
  }

  private async saveCurrentPosition(): Promise<void> {
    if (this.book) {
      await this.context.globalState.update(`${CHAPTER_PREFIX}${this.book.filePath}`, {
        chapter: this.currentChapterIndex,
        line: this.currentLine
      } satisfies ReadingPosition);
    }
  }

  private async rememberBook(filePath: string): Promise<void> {
    await this.rememberBooks([filePath]);
  }

  private async rememberBooks(filePaths: string[]): Promise<void> {
    const configuredMax = vscode.workspace.getConfiguration('consoleReader').get<number>('maxRecentBooks', 12);
    const maxRecent = Math.max(1, Math.min(30, configuredMax));
    const oldPaths = this.context.globalState.get<string[]>(RECENT_FILES_KEY, []);
    const uniquePaths = [...new Set(filePaths)];
    const paths = [...uniquePaths, ...oldPaths.filter(item => !uniquePaths.includes(item))].slice(0, maxRecent);
    await this.context.globalState.update(RECENT_FILES_KEY, paths);
    await this.context.globalState.update(LAST_FILE_KEY, uniquePaths[0]);
    this.bookShelf.setPaths(paths);
  }

  private async findSupportedPaths(paths: string[]): Promise<string[]> {
    const supportedPaths: string[] = [];
    for (const filePath of paths) {
      try {
        const stats = await fs.stat(filePath);
        if (stats.isDirectory()) {
          await this.collectSupportedFiles(filePath, supportedPaths);
        } else if (stats.isFile() && this.isSupportedPath(filePath)) {
          supportedPaths.push(filePath);
        }
      } catch {
        // Ignore paths that disappear or cannot be read while adding.
      }
    }
    return [...new Set(supportedPaths)];
  }

  private async collectSupportedFiles(directoryPath: string, result: string[]): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const childPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await this.collectSupportedFiles(childPath, result);
      } else if (entry.isFile() && this.isSupportedPath(childPath)) {
        result.push(childPath);
      }
    }
  }

  private async getRecentPaths(): Promise<string[]> {
    const paths = this.context.globalState.get<string[]>(RECENT_FILES_KEY, []);
    const existing: string[] = [];
    for (const filePath of paths) {
      try {
        await fs.access(filePath);
        existing.push(filePath);
      } catch {
        // Prune deleted or moved files from the quick-pick list.
      }
    }
    if (existing.length !== paths.length) {
      await this.context.globalState.update(RECENT_FILES_KEY, existing);
    }
    this.bookShelf.setPaths(existing);
    return existing;
  }

  private async refreshBookShelf(): Promise<void> {
    await this.getRecentPaths();
  }

  private updateStatusBar(): void {
    if (!this.book) {
      this.contentStatusBarItem.text = '';
      this.contentStatusBarItem.hide();
      this.controlStatusBarItem.text = '';
      this.controlStatusBarItem.hide();
      return;
    }
    const current = this.book.chapters.length > 0 ? this.currentChapterIndex + 1 : 0;
    const state = this.lineHidden ? '显示阅读行' : '隐藏阅读行';
    const chapter = this.book.chapters[this.currentChapterIndex];
    const currentLineText = chapter?.content.split('\n')[this.currentLine]?.trim() || '';
    const maxLength = Math.max(20, Math.min(160, vscode.workspace.getConfiguration('consoleReader').get<number>('statusBarMaxLength', 72)));
    const readableLine = currentLineText || '（空行）';
    const line = readableLine.length > maxLength ? `${readableLine.slice(0, maxLength)}…` : readableLine;
    this.contentStatusBarItem.text = `$(book) ${line}`;
    this.contentStatusBarItem.tooltip = `《${this.book.title}》\n第 ${current}/${this.book.chapters.length} 章 · 行 ${this.currentLine + 1}/${this.totalLines}\nCtrl/Cmd + ↑/↓ 翻行 · Ctrl/Cmd + ←/→ 切换章节`;
    if (this.lineHidden) {
      this.contentStatusBarItem.hide();
    } else {
      this.contentStatusBarItem.show();
    }
    this.controlStatusBarItem.text = this.lineHidden ? '$(eye-closed) 显示阅读行' : '$(eye) 隐藏阅读行';
    const visibilityShortcut = process.platform === 'darwin' ? 'Command + M' : 'Ctrl + M';
    this.controlStatusBarItem.tooltip = `${state}（${visibilityShortcut}）`;
    this.controlStatusBarItem.show();
  }

  private isSupportedPath(filePath: string): boolean {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);
  }
}
