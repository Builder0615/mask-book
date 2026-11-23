import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { BookShelfEntry, BookShelfProvider } from './bookshelf';
import { DisplayLine, getDisplayLines } from './line-utils';
import { LegadoBookSource, OnlineBookSourceService, OnlineSearchResult } from './online';
import { parseBook } from './parsers';
import { SourceTreeItem, SourceTreeProvider } from './sources';
import {
  Book,
  BookSourceSubscription,
  Chapter,
  OnlineBookReference,
  SUPPORTED_EXTENSIONS,
  TextEncoding
} from './types';

const LAST_FILE_KEY = 'consoleReader.lastFilePath';
const LAST_BOOK_KIND_KEY = 'consoleReader.lastBookKind';
const LAST_ONLINE_BOOK_KEY = 'consoleReader.lastOnlineBook';
const RECENT_FILES_KEY = 'consoleReader.recentFilePaths';
const RECENT_ONLINE_BOOKS_KEY = 'consoleReader.recentOnlineBooks';
const BOOK_SOURCES_KEY = 'consoleReader.bookSources';
const BOOK_SOURCE_SUBSCRIPTIONS_KEY = 'consoleReader.bookSourceSubscriptions';
const CHAPTER_PREFIX = 'consoleReader.chapter.';
const SHORTCUT_MODIFIER_LABELS: Record<string, string> = {
  alt: 'Alt',
  ctrl: 'Ctrl/Cmd',
  shift: 'Shift',
  'ctrl+alt': 'Ctrl/Cmd + Alt',
  'ctrl+shift': 'Ctrl/Cmd + Shift',
  'alt+shift': 'Alt + Shift',
  'ctrl+alt+shift': 'Ctrl/Cmd + Alt + Shift'
};

interface ReadingPosition {
  chapter: number;
  line: number;
  segment?: number;
}

function getReaderSetting<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration('maskRead').get<T>(key, defaultValue);
}

function getShortcutModifierLabel(settingKey: string): string {
  const configured = getReaderSetting<string>(settingKey, 'alt');
  return SHORTCUT_MODIFIER_LABELS[configured] ?? SHORTCUT_MODIFIER_LABELS.alt;
}

export class ChapterItem extends vscode.TreeItem {
  public readonly chapterId: string;

  public constructor(chapter: Chapter, index: number, isCurrent: boolean) {
    super(`${index + 1}. ${chapter.title}`, vscode.TreeItemCollapsibleState.None);
    this.chapterId = chapter.id;
    this.id = chapter.id;
    this.tooltip = isCurrent ? `${chapter.title}\n当前正在阅读` : chapter.title;
    this.description = isCurrent
      ? ['正在阅读', chapter.source].filter(Boolean).join(' · ')
      : chapter.source;
    this.contextValue = 'maskRead.chapter';
    this.iconPath = isCurrent
      ? new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('book');
    this.command = {
      command: 'maskRead.jumpToChapter',
      title: '阅读章节',
      arguments: [chapter.id]
    };
  }
}

export class ChapterTreeProvider implements vscode.TreeDataProvider<ChapterItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ChapterItem[] | undefined>();
  private chapters: Chapter[] = [];
  private items: ChapterItem[] = [];
  private currentChapterId: string | undefined;
  private treeView: vscode.TreeView<ChapterItem> | undefined;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public attachTreeView(treeView: vscode.TreeView<ChapterItem>): void {
    this.treeView = treeView;
    void this.revealCurrentChapter();
  }

  public setChapters(chapters: Chapter[], currentChapterId?: string): void {
    this.chapters = [...chapters];
    if (currentChapterId !== undefined) {
      this.currentChapterId = currentChapterId;
    }
    if (!this.chapters.some(chapter => chapter.id === this.currentChapterId)) {
      this.currentChapterId = undefined;
    }
    this.refreshItems();
    this.changeEmitter.fire(undefined);
    void this.revealCurrentChapter();
  }

  public setCurrentChapter(chapterId: string | undefined): void {
    this.currentChapterId = chapterId;
    this.refreshItems();
    this.changeEmitter.fire(undefined);
    void this.revealCurrentChapter();
  }

  public async revealCurrentChapter(): Promise<void> {
    const treeView = this.treeView;
    const item = this.items.find(chapter => chapter.chapterId === this.currentChapterId);
    if (!treeView || !treeView.visible || !item) {
      return;
    }
    try {
      await treeView.reveal(item, {
        select: true,
        focus: false,
        expand: false
      });
    } catch {
      // The view can be temporarily unavailable while VS Code is restoring its layout.
    }
  }

  public getTreeItem(element: ChapterItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ChapterItem): vscode.ProviderResult<ChapterItem[]> {
    if (element) {
      return [];
    }
    return this.items;
  }

  public getParent(_element: ChapterItem): vscode.ProviderResult<ChapterItem> {
    return undefined;
  }

  private refreshItems(): void {
    this.items = this.chapters.map((chapter, index) => new ChapterItem(
      chapter,
      index,
      chapter.id === this.currentChapterId
    ));
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

export class ReaderController implements vscode.Disposable {
  private static readonly STATUS_BAR_PRIORITY = -10000;

  public readonly chapterTree = new ChapterTreeProvider();
  public readonly bookShelf: BookShelfProvider;
  public readonly sourceTree: SourceTreeProvider;

  private book: Book | undefined;
  private currentChapterIndex = 0;
  private currentLine = 0;
  private currentLineSegment = 0;
  private totalLines = 1;
  private lineHidden = false;
  private loadSequence = 0;
  private positionSaveTimer: NodeJS.Timeout | undefined;
  private readonly onlineService = new OnlineBookSourceService();
  private readonly sourcesReady: Promise<void>;
  private readonly contentStatusBarItem: vscode.StatusBarItem;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.bookShelf = new BookShelfProvider({
      removeFromShelf: entry => void this.removeFromShelf(entry)
    });
    this.sourceTree = new SourceTreeProvider();
    this.contentStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      ReaderController.STATUS_BAR_PRIORITY
    );
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('maskRead.shortcut')) {
          this.updateStatusBar();
        }
      })
    );
    this.updateStatusBar();
    this.sourcesReady = this.restoreBookSources();
    void this.refreshBookShelf();
  }

  public get hasBook(): boolean {
    return Boolean(this.book);
  }

  public async restoreLastBook(): Promise<void> {
    await this.sourcesReady;
    const lastBookKind = this.context.globalState.get<'local' | 'online'>(LAST_BOOK_KIND_KEY);
    let lastOnlineBook = this.context.globalState.get<OnlineBookReference>(LAST_ONLINE_BOOK_KEY);
    const lastFilePath = this.context.globalState.get<string>(LAST_FILE_KEY);
    if (lastBookKind === 'online' && lastOnlineBook) {
      if (await this.openOnlineBook(lastOnlineBook, true)) {
        return;
      }
      await this.context.globalState.update(LAST_ONLINE_BOOK_KEY, undefined);
      lastOnlineBook = undefined;
    }

    if (lastFilePath) {
      try {
        await fs.access(lastFilePath);
        await this.openPath(lastFilePath, true);
        return;
      } catch {
        await this.context.globalState.update(LAST_FILE_KEY, undefined);
      }
    }

    if (lastOnlineBook) {
      if (!await this.openOnlineBook(lastOnlineBook, true)) {
        await this.context.globalState.update(LAST_ONLINE_BOOK_KEY, undefined);
      }
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

  public async add(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      '选择导入类型',
      { modal: true },
      '本地',
      '导入书源',
      '导入订阅源'
    );
    if (!choice) {
      return;
    }
    if (choice === '本地') {
      await this.addBook();
    } else if (choice === '导入书源') {
      await this.addBookSource();
    } else {
      await this.addSourceSubscription();
    }
  }

  public async addBookSource(): Promise<void> {
    await this.sourcesReady;
    const input = await vscode.window.showInputBox({
      prompt: '输入 Legado 书源 JSON 的 URL、本地文件路径，或直接粘贴 JSON',
      placeHolder: 'https://example.com/sources.json 或 /path/to/sources.json',
      ignoreFocusOut: true
    });
    if (!input) {
      return;
    }

    try {
      const imported = await this.onlineService.readSourceInput(input);
      const merged = this.mergeSources([...this.onlineService.getSources(), ...imported]);
      await this.saveBookSources(merged);
      vscode.window.showInformationMessage(`已导入 ${imported.length} 个书源，当前共 ${merged.length} 个。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Legado 书源导入失败：${message}`);
    }
  }

  public async importBookSources(): Promise<void> {
    await this.addBookSource();
  }

  public async addSourceSubscription(): Promise<void> {
    await this.sourcesReady;
    const input = await vscode.window.showInputBox({
      prompt: '输入 Legado 订阅源 URL',
      placeHolder: 'https://example.com/book-sources.json',
      ignoreFocusOut: true,
      validateInput: value => /^https?:\/\//i.test(value.trim()) ? undefined : '订阅源必须是 http(s) URL。'
    });
    if (!input?.trim()) {
      return;
    }

    const url = normalizeSubscriptionUrl(input.trim());
    if (!url) {
      vscode.window.showErrorMessage('订阅源 URL 无效。');
      return;
    }
    const oldSubscription = this.getSourceSubscriptions().find(subscription => subscription.url === url);
    const defaultName = oldSubscription?.name || subscriptionNameFromUrl(url);
    const name = await vscode.window.showInputBox({
      prompt: '输入订阅源名称',
      value: defaultName,
      placeHolder: '例如：我的小说书源',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : '订阅源名称不能为空。'
    });
    if (!name?.trim()) {
      return;
    }

    try {
      const imported = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在读取订阅源「${name.trim()}」`,
          cancellable: false
        },
        () => this.onlineService.readSourceInput(url)
      );
      const subscriptions = this.getSourceSubscriptions();
      const oldUrls = new Set(oldSubscription?.sourceUrls || []);
      const otherSubscriptionUrls = new Set(
        subscriptions
          .filter(subscription => subscription.id !== oldSubscription?.id)
          .flatMap(subscription => subscription.sourceUrls)
      );
      const retained = this.onlineService.getSources().filter(source => {
        return !oldUrls.has(source.bookSourceUrl) || otherSubscriptionUrls.has(source.bookSourceUrl);
      });
      const merged = this.mergeSources([...retained, ...imported]);
      const nextSubscription: BookSourceSubscription = {
        id: oldSubscription?.id || sourceSubscriptionId(url),
        name: name.trim(),
        url,
        sourceUrls: [...new Set(imported.map(source => source.bookSourceUrl))],
        updatedAt: new Date().toISOString()
      };
      const nextSubscriptions = [
        nextSubscription,
        ...subscriptions.filter(subscription => subscription.id !== nextSubscription.id)
      ];
      await this.saveBookSources(merged);
      await this.saveSourceSubscriptions(nextSubscriptions);
      vscode.window.showInformationMessage(`订阅源「${nextSubscription.name}」已保存，更新了 ${imported.length} 个书源。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`订阅源添加失败：${message}`);
    }
  }

  public async manageSourceSubscriptions(): Promise<void> {
    await this.sourcesReady;
    const subscriptions = this.getSourceSubscriptions();
    if (subscriptions.length === 0) {
      const action = await vscode.window.showInformationMessage('还没有保存的订阅源。', '添加订阅源');
      if (action === '添加订阅源') {
        await this.addSourceSubscription();
      }
      return;
    }

    const selected = await vscode.window.showQuickPick([
      { label: '$(sync) 刷新全部订阅源', value: 'refreshAll' as const },
      ...subscriptions.map(subscription => ({
        label: `$(rss) ${subscription.name}`,
        description: subscription.url,
        detail: `${subscription.sourceUrls.length} 个书源${subscription.updatedAt ? ` · 上次更新 ${formatSubscriptionDate(subscription.updatedAt)}` : ''}`,
        value: 'subscription' as const,
        subscription
      }))
    ], {
      title: '管理订阅源',
      placeHolder: '刷新全部，或选择一个订阅源进行管理'
    });
    if (!selected) {
      return;
    }
    if (selected.value === 'refreshAll') {
      await this.refreshSourceSubscriptions();
      return;
    }

    const action = await vscode.window.showQuickPick([
      { label: '$(sync) 刷新此订阅源', value: 'refresh' },
      { label: '$(edit) 重命名', value: 'rename' },
      { label: '$(trash) 删除订阅源及其书源', value: 'delete' }
    ], {
      title: `管理订阅源：${selected.subscription.name}`
    });
    if (!action) {
      return;
    }
    if (action.value === 'refresh') {
      await this.refreshOneSourceSubscription(selected.subscription, true);
    } else if (action.value === 'rename') {
      await this.renameSourceSubscription(selected.subscription);
    } else {
      await this.deleteSourceSubscription(selected.subscription);
    }
  }

  public async refreshSourceSubscriptions(): Promise<void> {
    await this.sourcesReady;
    const subscriptions = this.getSourceSubscriptions();
    if (subscriptions.length === 0) {
      vscode.window.showInformationMessage('还没有保存的订阅源。');
      return;
    }
    const result = await this.refreshStoredSubscriptions(true);
    if (result.failures.length === 0) {
      vscode.window.showInformationMessage(`已刷新 ${result.updated} 个订阅源，共更新 ${result.sourceCount} 个书源。`);
    } else {
      vscode.window.showWarningMessage(`已刷新 ${result.updated} 个订阅源，${result.failures.length} 个订阅源失败。`);
    }
  }

  public refreshSourceTree(): void {
    this.sourceTree.setSources(this.onlineService.getSources(), this.getSourceSubscriptions());
  }

  public async openSourceUrl(item: SourceTreeItem | string | undefined): Promise<void> {
    const url = typeof item === 'string'
      ? item
      : item?.node.kind === 'bookSource'
        ? item.node.source.bookSourceUrl
        : item?.node.kind === 'subscription'
          ? item.node.subscription.url
          : undefined;
    if (!url) {
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  public async toggleBookSource(item: SourceTreeItem | undefined): Promise<void> {
    const source = getBookSourceFromTreeItem(item);
    if (!source) {
      return;
    }
    await this.sourcesReady;
    const current = this.onlineService.getSources().find(value => value.bookSourceUrl === source.bookSourceUrl);
    if (!current) {
      return;
    }
    const enabled = current.enabled === false;
    const sources = this.onlineService.getSources().map(value => value.bookSourceUrl === current.bookSourceUrl
      ? { ...value, enabled }
      : value);
    await this.saveBookSources(sources);
    vscode.window.showInformationMessage(
      `书源「${current.bookSourceName || current.bookSourceUrl}」已${enabled ? '启用' : '停用'}。`
    );
  }

  public selectAllSources(): void {
    this.sourceTree.selectAll();
  }

  public async deleteSelectedSources(
    selectedItems: readonly SourceTreeItem[] = [],
    includeCheckedItems = true
  ): Promise<void> {
    await this.sourcesReady;
    const candidates = includeCheckedItems
      ? [...this.sourceTree.getCheckedItems(), ...selectedItems]
      : [...selectedItems];
    const uniqueItems = new Map<string, SourceTreeItem>();
    for (const item of candidates) {
      const key = sourceTreeItemKey(item);
      if (key) {
        uniqueItems.set(key, item);
      }
    }
    const items = [...uniqueItems.values()];
    const selectedSources = items
      .map(item => getBookSourceFromTreeItem(item))
      .filter((source): source is LegadoBookSource => Boolean(source));
    const selectedSubscriptions = items
      .map(item => getSubscriptionFromTreeItem(item))
      .filter((subscription): subscription is BookSourceSubscription => Boolean(subscription));
    if (selectedSources.length === 0 && selectedSubscriptions.length === 0) {
      vscode.window.showInformationMessage('请先勾选或多选要删除的书源或订阅源。');
      return;
    }

    const selectedSubscriptionIds = new Set(selectedSubscriptions.map(subscription => subscription.id));
    const explicitlyRemovedUrls = new Set(selectedSources.map(source => source.bookSourceUrl));
    const subscriptions = this.getSourceSubscriptions();
    const nextSubscriptions = subscriptions
      .filter(subscription => !selectedSubscriptionIds.has(subscription.id))
      .map(subscription => explicitlyRemovedUrls.size === 0
        ? subscription
        : {
          ...subscription,
          sourceUrls: subscription.sourceUrls.filter(url => !explicitlyRemovedUrls.has(url))
        });
    const remainingOwnedUrls = new Set(nextSubscriptions.flatMap(subscription => subscription.sourceUrls));
    const removedUrls = new Set(explicitlyRemovedUrls);
    for (const subscription of selectedSubscriptions) {
      for (const url of subscription.sourceUrls) {
        if (!remainingOwnedUrls.has(url)) {
          removedUrls.add(url);
        }
      }
    }

    const currentSources = this.onlineService.getSources();
    const nextSources = currentSources.filter(source => !removedUrls.has(source.bookSourceUrl));
    const removedSourceCount = currentSources.length - nextSources.length;
    const summary = [
      selectedSources.length > 0 ? `${selectedSources.length} 个书源` : '',
      selectedSubscriptions.length > 0 ? `${selectedSubscriptions.length} 个订阅源` : ''
    ].filter(Boolean).join('和');
    const confirmation = await vscode.window.showWarningMessage(
      `确定删除选中的 ${summary} 吗？`,
      { modal: true },
      '删除'
    );
    if (confirmation !== '删除') {
      return;
    }
    await this.saveBookSources(nextSources);
    await this.saveSourceSubscriptions(nextSubscriptions);
    vscode.window.showInformationMessage(
      `已删除 ${removedSourceCount} 个书源和 ${selectedSubscriptions.length} 个订阅源。`
    );
  }

  public async removeBookSource(
    item: SourceTreeItem | undefined,
    selectedItems: readonly SourceTreeItem[] = []
  ): Promise<void> {
    const items = (selectedItems.length > 0 ? selectedItems : item ? [item] : [])
      .filter(candidate => getBookSourceFromTreeItem(candidate));
    await this.deleteSelectedSources(items, false);
  }

  public async refreshSourceSubscription(item: SourceTreeItem | undefined): Promise<void> {
    const subscription = getSubscriptionFromTreeItem(item);
    if (!subscription) {
      return;
    }
    await this.sourcesReady;
    await this.refreshOneSourceSubscription(subscription, true);
  }

  public async renameSourceSubscriptionFromTree(item: SourceTreeItem | undefined): Promise<void> {
    const subscription = getSubscriptionFromTreeItem(item);
    if (subscription) {
      await this.renameSourceSubscription(subscription);
    }
  }

  public async deleteSourceSubscriptionFromTree(
    item: SourceTreeItem | undefined,
    selectedItems: readonly SourceTreeItem[] = []
  ): Promise<void> {
    const items = (selectedItems.length > 0 ? selectedItems : item ? [item] : [])
      .filter(candidate => getSubscriptionFromTreeItem(candidate));
    if (items.length > 1) {
      await this.deleteSelectedSources(items, false);
      return;
    }
    const subscription = getSubscriptionFromTreeItem(items[0]);
    if (subscription) {
      await this.deleteSourceSubscription(subscription);
    }
  }

  public async searchOnlineBook(): Promise<void> {
    await this.sourcesReady;
    const key = await vscode.window.showInputBox({
      prompt: '输入书名或作者，搜索在线书籍',
      placeHolder: '例如：三体',
      ignoreFocusOut: true
    });
    if (!key?.trim()) {
      return;
    }

    let sources = this.onlineService.getSearchableSources();
    if (sources.length === 0) {
      const importedSources = this.onlineService.getSources();
      const message = importedSources.length === 0
        ? '还没有导入可搜索的 Legado 书源，请先导入书源 JSON。'
        : `已导入 ${importedSources.length} 个源，但没有可搜索的在线书源。请确认源包含 searchUrl 和 ruleSearch.bookList；阅读 APP 的文章/资讯订阅源不能用于小说搜索。`;
      const action = await vscode.window.showInformationMessage(message, '导入书源');
      if (action === '导入书源') {
        await this.importBookSources();
      }
      return;
    }

    const configuredMax = getReaderSetting('onlineSearchMaxSources', 12);
    const maxSources = Math.max(1, Math.min(100, configuredMax));
    const limited = sources.length > maxSources;
    sources = sources.slice(0, maxSources);
    const batch = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在搜索《${key.trim()}》${limited ? `（${sources.length} 个书源）` : ''}`,
        cancellable: false
      },
      () => this.onlineService.search(key.trim(), sources)
    );

    if (batch.results.length === 0) {
      const suffix = batch.failures.length > 0 ? `，${batch.failures.length} 个书源请求失败` : '';
      vscode.window.showWarningMessage(`没有找到《${key.trim()}》${suffix}。`);
      return;
    }

    const items = batch.results.map(result => ({
      label: result.title,
      description: [result.author, result.sourceName].filter(Boolean).join(' · '),
      detail: [result.kind, result.lastChapter, result.intro].filter(Boolean).join(' · '),
      result
    }));
    const selected = await vscode.window.showQuickPick(items, {
      title: `在线搜索结果：${key.trim()}`,
      placeHolder: `共 ${batch.results.length} 条结果，选择后读取章节目录`,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!selected) {
      return;
    }
    await this.openOnlineSearchResult(selected.result);
  }

  public async openOnlineBook(reference: OnlineBookReference, showLine: boolean): Promise<boolean> {
    await this.sourcesReady;
    const sequence = ++this.loadSequence;
    try {
      this.onlineService.setTimeoutMs(this.getOnlineRequestTimeout());
      const book = this.onlineService.bookFromReference(reference);
      await this.finishOpeningBook(book, showLine, sequence, true);
      return sequence === this.loadSequence;
    } catch (error) {
      if (sequence !== this.loadSequence) {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`在线书籍打开失败：${message}`);
      return false;
    }
  }

  public async openPath(filePath: string, showLine: boolean): Promise<void> {
    const sequence = ++this.loadSequence;
    const absolutePath = path.resolve(filePath);
    try {
      await fs.access(absolutePath);
      const textEncoding = getReaderSetting<TextEncoding>('textEncoding', 'auto');
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
      this.setCurrentLine(position.line, book.chapters[this.currentChapterIndex], position.segment);
      this.chapterTree.setChapters(book.chapters, book.chapters[this.currentChapterIndex]?.id);
      this.lineHidden = !showLine;
      await this.rememberBook(absolutePath);
      await this.saveCurrentPosition();
      await vscode.commands.executeCommand('setContext', 'maskRead.hasBook', true);
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
      vscode.window.showErrorMessage(`mask-read 打开失败：${message}`);
    }
  }

  private async openOnlineSearchResult(result: OnlineSearchResult): Promise<void> {
    const sequence = ++this.loadSequence;
    try {
      this.onlineService.setTimeoutMs(this.getOnlineRequestTimeout());
      const book = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在读取《${result.title}》目录`,
          cancellable: false
        },
        () => this.onlineService.openSearchResult(result)
      );
      if (sequence !== this.loadSequence) {
        return;
      }
      await this.finishOpeningBook(book, true, sequence, true);
    } catch (error) {
      if (sequence !== this.loadSequence) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`在线书籍打开失败：${message}`);
    }
  }

  private async finishOpeningBook(book: Book, showLine: boolean, sequence: number, loadFirstChapter: boolean): Promise<void> {
    if (sequence !== this.loadSequence) {
      return;
    }
    this.book = book;
    const position = this.restorePosition(book);
    this.currentChapterIndex = position.chapter;
    this.currentLine = position.line;
    this.currentLineSegment = position.segment ?? 0;
    this.chapterTree.setChapters(book.chapters, book.chapters[this.currentChapterIndex]?.id);
    this.lineHidden = !showLine;
    if (book.online) {
      await this.rememberOnlineBook(book.online);
      if (loadFirstChapter && book.chapters[this.currentChapterIndex]) {
        await this.ensureChapterContent(this.currentChapterIndex, sequence);
        this.setCurrentLine(position.line, book.chapters[this.currentChapterIndex], position.segment);
      } else {
        this.setCurrentLine(position.line, book.chapters[this.currentChapterIndex], position.segment);
      }
    } else {
      this.setCurrentLine(position.line, book.chapters[this.currentChapterIndex], position.segment);
    }
    await this.saveCurrentPosition();
    await vscode.commands.executeCommand('setContext', 'maskRead.hasBook', true);
    this.updateStatusBar();
    vscode.window.setStatusBarMessage(
      `已打开《${book.title}》 · ${book.chapters.length} 个章节${book.online ? ' · 在线' : ''}`,
      3000
    );
  }

  private async ensureChapterContent(chapterIndex: number, sequence = this.loadSequence): Promise<void> {
    const book = this.book;
    const chapter = book?.chapters[chapterIndex];
    if (!book?.online || !chapter || chapter.contentLoaded) {
      return;
    }
    const reference = book.online.chapters[chapterIndex];
    if (!reference) {
      return;
    }
    const content = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在加载 ${chapter.title}`,
        cancellable: false
      },
      () => this.onlineService.loadChapterContent(book.online as OnlineBookReference, reference)
    );
    if (sequence !== this.loadSequence || this.book !== book) {
      return;
    }
    chapter.content = content;
    chapter.contentLoaded = true;
    book.text = book.chapters.map(item => `${item.title}\n\n${item.content}`).join('\n\n');
    this.chapterTree.setChapters(book.chapters);
  }

  public async jumpToChapter(chapterId: string, position: 'start' | 'end' = 'start'): Promise<void> {
    if (!this.book) {
      return;
    }
    const index = this.book.chapters.findIndex(chapter => chapter.id === chapterId);
    if (index < 0) {
      return;
    }
    const sequence = this.loadSequence;
    try {
      await this.ensureChapterContent(index, sequence);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`章节加载失败：${message}`);
      return;
    }
    if (!this.book || sequence !== this.loadSequence) {
      return;
    }
    this.currentChapterIndex = index;
    this.setCurrentLine(position === 'end' ? Number.MAX_SAFE_INTEGER : 0, this.book.chapters[index]);
    this.chapterTree.setCurrentChapter(this.book.chapters[index].id);
    this.lineHidden = false;
    this.scheduleSavePosition();
    this.updateStatusBar();
  }

  public async moveLine(delta: number): Promise<void> {
    if (!this.book) {
      return;
    }
    const sequence = this.loadSequence;
    try {
      await this.ensureChapterContent(this.currentChapterIndex, sequence);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`章节加载失败：${message}`);
      return;
    }
    if (!this.book || sequence !== this.loadSequence) {
      return;
    }
    const chapter = this.book.chapters[this.currentChapterIndex];
    const displayLines = this.getDisplayLines(chapter?.content ?? '');
    this.totalLines = displayLines.length;
    if (displayLines.length === 0) {
      if (delta < 0 && this.currentChapterIndex > 0) {
        await this.previousChapterFromLine();
        return;
      }
      if (delta > 0 && this.currentChapterIndex < this.book.chapters.length - 1) {
        await this.nextChapter();
        return;
      }
      this.currentLine = 0;
      this.currentLineSegment = 0;
      this.scheduleSavePosition();
      this.updateStatusBar();
      return;
    }

    let currentPosition = this.findCurrentDisplayLine(displayLines);
    if (currentPosition < 0) {
      currentPosition = displayLines.findIndex(line => line.rawIndex >= this.currentLine);
      if (currentPosition < 0) {
        currentPosition = displayLines.length - 1;
      }
    }
    if (delta < 0 && currentPosition === 0 && this.currentChapterIndex > 0) {
      await this.previousChapterFromLine();
      return;
    }
    if (delta > 0 && currentPosition === displayLines.length - 1 && this.currentChapterIndex < this.book.chapters.length - 1) {
      await this.nextChapter();
      return;
    }
    const nextPosition = Math.max(0, Math.min(displayLines.length - 1, currentPosition + delta));
    this.currentLine = displayLines[nextPosition].rawIndex;
    this.currentLineSegment = displayLines[nextPosition].segment;
    this.scheduleSavePosition();
    this.updateStatusBar();
  }

  public async nextChapter(): Promise<void> {
    if (!this.book) {
      return;
    }
    const nextIndex = Math.min(this.book.chapters.length - 1, this.currentChapterIndex + 1);
    await this.jumpToChapter(this.book.chapters[nextIndex].id, 'start');
  }

  public async previousChapter(): Promise<void> {
    if (!this.book) {
      return;
    }
    const previousIndex = Math.max(0, this.currentChapterIndex - 1);
    await this.jumpToChapter(this.book.chapters[previousIndex].id, 'start');
  }

  private async previousChapterFromLine(): Promise<void> {
    if (!this.book) {
      return;
    }
    const previousIndex = Math.max(0, this.currentChapterIndex - 1);
    await this.jumpToChapter(this.book.chapters[previousIndex].id, 'end');
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
    this.loadSequence += 1;
    this.book = undefined;
    this.currentChapterIndex = 0;
    this.chapterTree.setChapters([]);
    this.currentLine = 0;
    this.currentLineSegment = 0;
    this.totalLines = 1;
    this.lineHidden = false;
    void vscode.commands.executeCommand('setContext', 'maskRead.hasBook', false);
    this.updateStatusBar();
  }

  public async removeFromShelf(entry: BookShelfEntry): Promise<void> {
    if (entry.onlineBook) {
      const books = this.getRecentOnlineBooks();
      const remaining = books.filter(book => book.id !== entry.onlineBook?.id);
      await this.context.globalState.update(RECENT_ONLINE_BOOKS_KEY, remaining);
      if (this.context.globalState.get<OnlineBookReference>(LAST_ONLINE_BOOK_KEY)?.id === entry.onlineBook.id) {
        await this.context.globalState.update(LAST_ONLINE_BOOK_KEY, remaining[0]);
      }
      if (this.book?.filePath === entry.onlineBook.id) {
        this.closeBook();
      }
    } else if (entry.filePath) {
      const paths = await this.getRecentPaths();
      const remaining = paths.filter(item => item !== entry.filePath);
      await this.context.globalState.update(RECENT_FILES_KEY, remaining);
      if (this.context.globalState.get<string>(LAST_FILE_KEY) === entry.filePath) {
        await this.context.globalState.update(LAST_FILE_KEY, remaining[0]);
      }
    }
    await this.refreshBookShelf();
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
    this.sourceTree.dispose();
    this.contentStatusBarItem.dispose();
  }

  private restorePosition(book: Book): ReadingPosition {
    const saved = this.context.globalState.get<ReadingPosition | number>(`${CHAPTER_PREFIX}${book.filePath}`);
    const chapter = typeof saved === 'number' ? saved : saved?.chapter ?? 0;
    const line = typeof saved === 'number' ? 0 : saved?.line ?? 0;
    return {
      chapter: Math.max(0, Math.min(chapter, Math.max(0, book.chapters.length - 1))),
      line: Math.max(0, line),
      segment: Math.max(0, typeof saved === 'number' ? 0 : saved?.segment ?? 0)
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
        line: this.currentLine,
        segment: this.currentLineSegment
      } satisfies ReadingPosition);
    }
  }

  private setCurrentLine(
    preferredLine: number,
    chapter = this.book?.chapters[this.currentChapterIndex],
    preferredSegment = 0
  ): void {
    const displayLines = this.getDisplayLines(chapter?.content ?? '');
    this.totalLines = displayLines.length;
    if (displayLines.length === 0) {
      this.currentLine = 0;
      this.currentLineSegment = 0;
      return;
    }

    const line = displayLines.find(item => item.rawIndex === preferredLine && item.segment === preferredSegment)
      ?? displayLines.find(item => item.rawIndex >= preferredLine)
      ?? displayLines[displayLines.length - 1];
    this.currentLine = line.rawIndex;
    this.currentLineSegment = line.segment;
  }

  private async rememberBook(filePath: string): Promise<void> {
    await this.rememberBooks([filePath]);
  }

  private async rememberBooks(filePaths: string[]): Promise<void> {
    const configuredMax = getReaderSetting('maxRecentBooks', 12);
    const maxRecent = Math.max(1, Math.min(30, configuredMax));
    const oldPaths = this.context.globalState.get<string[]>(RECENT_FILES_KEY, []);
    const uniquePaths = [...new Set(filePaths)];
    const paths = [...uniquePaths, ...oldPaths.filter(item => !uniquePaths.includes(item))].slice(0, maxRecent);
    await this.context.globalState.update(RECENT_FILES_KEY, paths);
    await this.context.globalState.update(LAST_FILE_KEY, uniquePaths[0]);
    await this.context.globalState.update(LAST_BOOK_KIND_KEY, 'local');
    await this.refreshBookShelf();
  }

  private async rememberOnlineBook(reference: OnlineBookReference): Promise<void> {
    const configuredMax = getReaderSetting('maxRecentBooks', 12);
    const maxRecent = Math.max(1, Math.min(30, configuredMax));
    const oldBooks = this.getRecentOnlineBooks();
    const books = [reference, ...oldBooks.filter(book => book.id !== reference.id)].slice(0, maxRecent);
    await this.context.globalState.update(RECENT_ONLINE_BOOKS_KEY, books);
    await this.context.globalState.update(LAST_ONLINE_BOOK_KEY, reference);
    await this.context.globalState.update(LAST_BOOK_KIND_KEY, 'online');
    await this.refreshBookShelf();
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
    return existing;
  }

  private async refreshBookShelf(): Promise<void> {
    const paths = await this.getRecentPaths();
    const onlineBooks = this.getRecentOnlineBooks();
    this.bookShelf.setEntries([
      ...onlineBooks.map(book => ({
        id: book.id,
        title: book.title,
        description: `${book.sourceName}${book.author ? ` · ${book.author}` : ''} · 在线`,
        onlineBook: book
      } satisfies BookShelfEntry)),
      ...paths.map(filePath => ({
        id: filePath,
        title: path.basename(filePath),
        description: path.dirname(filePath),
        filePath
      } satisfies BookShelfEntry))
    ]);
  }

  private getRecentOnlineBooks(): OnlineBookReference[] {
    const stored = this.context.globalState.get<OnlineBookReference[]>(RECENT_ONLINE_BOOKS_KEY, []);
    return stored.filter(book => Boolean(
      book && book.id && book.sourceUrl && book.bookUrl && book.title && Array.isArray(book.chapters)
    ));
  }

  private getSourceSubscriptions(): BookSourceSubscription[] {
    const stored = this.context.globalState.get<unknown>(BOOK_SOURCE_SUBSCRIPTIONS_KEY, []);
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored
      .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
      .map(value => ({
        id: typeof value.id === 'string' ? value.id : '',
        name: typeof value.name === 'string' ? value.name : '',
        url: typeof value.url === 'string' ? normalizeSubscriptionUrl(value.url) : '',
        sourceUrls: Array.isArray(value.sourceUrls)
          ? value.sourceUrls.filter((item): item is string => typeof item === 'string')
          : [],
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined
      }))
      .filter(subscription => Boolean(subscription.id && subscription.name && subscription.url));
  }

  private async saveBookSources(sources: LegadoBookSource[]): Promise<void> {
    this.onlineService.setSources(sources);
    await this.context.globalState.update(BOOK_SOURCES_KEY, this.onlineService.getSources());
    this.refreshSourceTree();
  }

  private async saveSourceSubscriptions(subscriptions: BookSourceSubscription[]): Promise<void> {
    await this.context.globalState.update(BOOK_SOURCE_SUBSCRIPTIONS_KEY, subscriptions);
    this.refreshSourceTree();
  }

  private mergeSources(sources: LegadoBookSource[]): LegadoBookSource[] {
    const existing = new Map(this.onlineService.getSources().map(source => [source.bookSourceUrl, source]));
    return [...new Map(sources.map(source => {
      const previous = existing.get(source.bookSourceUrl);
      const merged = previous?.enabled === false && source.enabled !== false
        ? { ...source, enabled: false }
        : source;
      return [source.bookSourceUrl, merged] as const;
    })).values()];
  }

  private async refreshStoredSubscriptions(showProgress: boolean): Promise<{
    updated: number;
    sourceCount: number;
    failures: string[];
  }> {
    const subscriptions = this.getSourceSubscriptions();
    const failures: string[] = [];
    let updated = 0;
    let sourceCount = 0;
    const refresh = async (report?: (message: string) => void): Promise<void> => {
      for (const subscription of subscriptions) {
        report?.(`正在刷新 ${subscription.name}`);
        try {
          sourceCount += await this.refreshOneSourceSubscription(subscription, false);
          updated += 1;
        } catch (error) {
          failures.push(`${subscription.name}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };

    if (showProgress) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '正在刷新订阅源',
          cancellable: false
        },
        (_progress, cancellationToken) => {
          if (cancellationToken.isCancellationRequested) {
            return Promise.resolve();
          }
          return refresh(message => _progress.report({ message }));
        }
      );
    } else {
      await refresh();
    }
    return { updated, sourceCount, failures };
  }

  private async refreshOneSourceSubscription(subscription: BookSourceSubscription, showMessage: boolean): Promise<number> {
    try {
      const imported = await this.onlineService.readSourceInput(subscription.url);
      const subscriptions = this.getSourceSubscriptions();
      const oldUrls = new Set(subscription.sourceUrls);
      const otherSubscriptionUrls = new Set(
        subscriptions
          .filter(item => item.id !== subscription.id)
          .flatMap(item => item.sourceUrls)
      );
      const retained = this.onlineService.getSources().filter(source => {
        return !oldUrls.has(source.bookSourceUrl) || otherSubscriptionUrls.has(source.bookSourceUrl);
      });
      const merged = this.mergeSources([...retained, ...imported]);
      const updatedSubscription: BookSourceSubscription = {
        ...subscription,
        sourceUrls: [...new Set(imported.map(source => source.bookSourceUrl))],
        updatedAt: new Date().toISOString()
      };
      const nextSubscriptions = subscriptions.map(item => item.id === subscription.id ? updatedSubscription : item);
      await this.saveBookSources(merged);
      await this.saveSourceSubscriptions(nextSubscriptions);
      if (showMessage) {
        vscode.window.showInformationMessage(`订阅源「${subscription.name}」已刷新，更新了 ${imported.length} 个书源。`);
      }
      return imported.length;
    } catch (error) {
      if (showMessage) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`订阅源刷新失败：${message}`);
      }
      throw error;
    }
  }

  private async renameSourceSubscription(subscription: BookSourceSubscription): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: '输入新的订阅源名称',
      value: subscription.name,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : '订阅源名称不能为空。'
    });
    if (!name?.trim()) {
      return;
    }
    const subscriptions = this.getSourceSubscriptions().map(item => item.id === subscription.id
      ? { ...item, name: name.trim() }
      : item);
    await this.saveSourceSubscriptions(subscriptions);
    vscode.window.showInformationMessage(`订阅源已重命名为「${name.trim()}」。`);
  }

  private async deleteSourceSubscription(subscription: BookSourceSubscription): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      `确定删除订阅源「${subscription.name}」及其导入的书源吗？`,
      { modal: true },
      '删除'
    );
    if (confirmation !== '删除') {
      return;
    }
    const subscriptions = this.getSourceSubscriptions().filter(item => item.id !== subscription.id);
    const remainingUrls = new Set(subscriptions.flatMap(item => item.sourceUrls));
    const removedUrls = new Set(subscription.sourceUrls);
    const sources = this.onlineService.getSources().filter(source => {
      return !removedUrls.has(source.bookSourceUrl) || remainingUrls.has(source.bookSourceUrl);
    });
    await this.saveBookSources(sources);
    await this.saveSourceSubscriptions(subscriptions);
    vscode.window.showInformationMessage(`订阅源「${subscription.name}」已删除。`);
  }

  private async restoreBookSources(): Promise<void> {
    const stored = this.context.globalState.get<LegadoBookSource[]>(BOOK_SOURCES_KEY, []);
    this.onlineService.setSources(Array.isArray(stored) ? stored : []);
    this.onlineService.setTimeoutMs(this.getOnlineRequestTimeout());
    if (this.getSourceSubscriptions().length > 0) {
      await this.refreshStoredSubscriptions(false);
    }
    this.refreshSourceTree();
  }

  private getOnlineRequestTimeout(): number {
    return getReaderSetting('onlineRequestTimeoutMs', 15000);
  }

  private updateStatusBar(): void {
    if (!this.book) {
      this.contentStatusBarItem.text = '';
      this.contentStatusBarItem.hide();
      return;
    }
    const current = this.book.chapters.length > 0 ? this.currentChapterIndex + 1 : 0;
    const chapter = this.book.chapters[this.currentChapterIndex];
    const displayLines = this.getDisplayLines(chapter?.content ?? '');
    this.totalLines = displayLines.length;
    const currentLinePosition = this.findCurrentDisplayLine(displayLines);
    const currentLineText = currentLinePosition >= 0 ? displayLines[currentLinePosition].text : '';
    const line = currentLineText;
    const displayedLine = currentLinePosition >= 0 ? currentLinePosition + 1 : 0;
    const lineModifier = getShortcutModifierLabel('shortcut.lineModifier');
    const chapterModifier = getShortcutModifierLabel('shortcut.chapterModifier');
    const toggleModifier = getShortcutModifierLabel('shortcut.toggleModifier');
    const keyboardHelp = `快捷键：${lineModifier} + ←/→ 翻行，${chapterModifier} + ↑/↓ 切换章节，${toggleModifier} + 空格显示/隐藏阅读行`;
    if (this.lineHidden) {
      this.contentStatusBarItem.text = '$(book)';
      this.contentStatusBarItem.tooltip = `《${this.book.title}》\n阅读行已隐藏\n${keyboardHelp}`;
    } else {
      this.contentStatusBarItem.text = line ? `$(book) ${line}` : '$(book)';
      this.contentStatusBarItem.tooltip = `《${this.book.title}》\n第 ${current}/${this.book.chapters.length} 章 · 行 ${displayedLine}/${this.totalLines}\n${keyboardHelp}`;
    }
    this.contentStatusBarItem.show();
  }

  private getDisplayLines(content: string): DisplayLine[] {
    return getDisplayLines(content, this.getStatusBarMaxLength());
  }

  private getStatusBarMaxLength(): number {
    const configured = getReaderSetting('statusBarMaxLength', 72);
    return Math.max(20, Math.min(160, Math.floor(configured)));
  }

  private findCurrentDisplayLine(displayLines: DisplayLine[]): number {
    return displayLines.findIndex(line => (
      line.rawIndex === this.currentLine && line.segment === this.currentLineSegment
    ));
  }

  private isSupportedPath(filePath: string): boolean {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);
  }
}

function normalizeSubscriptionUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    return /^https?:$/i.test(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function sourceSubscriptionId(url: string): string {
  return `source-subscription:${encodeURIComponent(url)}`;
}

function subscriptionNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || '未命名订阅源';
  } catch {
    return '未命名订阅源';
  }
}

function formatSubscriptionDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function getBookSourceFromTreeItem(item: SourceTreeItem | undefined): LegadoBookSource | undefined {
  return item?.node.kind === 'bookSource' ? item.node.source : undefined;
}

function getSubscriptionFromTreeItem(item: SourceTreeItem | undefined): BookSourceSubscription | undefined {
  return item?.node.kind === 'subscription' ? item.node.subscription : undefined;
}

function sourceTreeItemKey(item: SourceTreeItem | undefined): string | undefined {
  const source = getBookSourceFromTreeItem(item);
  if (source) {
    return `bookSource:${source.bookSourceUrl}`;
  }
  const subscription = getSubscriptionFromTreeItem(item);
  return subscription ? `subscription:${subscription.id}` : undefined;
}
