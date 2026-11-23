import * as vscode from 'vscode';
import { BookShelfItem } from './bookshelf';
import { ReaderController } from './reader';
import type { SourceTreeItem } from './sources';

export function activate(context: vscode.ExtensionContext): void {
  const reader = new ReaderController(context);
  context.subscriptions.push(reader);

  const shelfView = vscode.window.createTreeView('consoleReader.bookshelf', {
    treeDataProvider: reader.bookShelf,
    showCollapseAll: false,
    canSelectMany: false
  });
  context.subscriptions.push(shelfView);

  const chapterView = vscode.window.createTreeView('consoleReader.chapters', {
    treeDataProvider: reader.chapterTree,
    showCollapseAll: false,
    canSelectMany: false
  });
  reader.chapterTree.attachTreeView(chapterView);
  context.subscriptions.push(
    chapterView,
    chapterView.onDidChangeVisibility(event => {
      if (event.visible) {
        void reader.chapterTree.revealCurrentChapter();
      }
    })
  );

  const sourceView = vscode.window.createTreeView('consoleReader.sources', {
    treeDataProvider: reader.sourceTree,
    showCollapseAll: true,
    canSelectMany: true,
    manageCheckboxStateManually: true
  });
  context.subscriptions.push(
    sourceView,
    sourceView.onDidChangeCheckboxState(event => reader.sourceTree.setCheckedState(event.items))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('maskRead.add', () => reader.add()),
    vscode.commands.registerCommand('maskRead.addBook', () => reader.addBook()),
    vscode.commands.registerCommand('maskRead.openPath', (filePath: string) => reader.openPath(filePath, true)),
    vscode.commands.registerCommand('maskRead.addBookSource', () => reader.addBookSource()),
    vscode.commands.registerCommand('maskRead.addSourceSubscription', () => reader.addSourceSubscription()),
    vscode.commands.registerCommand('maskRead.manageSourceSubscriptions', () => reader.manageSourceSubscriptions()),
    vscode.commands.registerCommand('maskRead.refreshSourceSubscriptions', () => reader.refreshSourceSubscriptions()),
    vscode.commands.registerCommand('maskRead.refreshSourceTree', () => reader.refreshSourceTree()),
    vscode.commands.registerCommand('maskRead.openSourceUrl', (item: SourceTreeItem | string) => reader.openSourceUrl(item)),
    vscode.commands.registerCommand('maskRead.toggleBookSource', (item: SourceTreeItem) => reader.toggleBookSource(item)),
    vscode.commands.registerCommand(
      'maskRead.removeBookSource',
      (item: SourceTreeItem, selectedItems: readonly SourceTreeItem[]) => reader.removeBookSource(item, selectedItems)
    ),
    vscode.commands.registerCommand('maskRead.refreshSourceSubscription', (item: SourceTreeItem) => reader.refreshSourceSubscription(item)),
    vscode.commands.registerCommand('maskRead.renameSourceSubscription', (item: SourceTreeItem) => reader.renameSourceSubscriptionFromTree(item)),
    vscode.commands.registerCommand(
      'maskRead.deleteSourceSubscription',
      (item: SourceTreeItem, selectedItems: readonly SourceTreeItem[]) => reader.deleteSourceSubscriptionFromTree(item, selectedItems)
    ),
    vscode.commands.registerCommand('maskRead.selectAllSources', () => reader.selectAllSources()),
    vscode.commands.registerCommand('maskRead.deleteSelectedSources', () => reader.deleteSelectedSources(sourceView.selection)),
    vscode.commands.registerCommand('maskRead.importBookSources', () => reader.importBookSources()),
    vscode.commands.registerCommand('maskRead.searchOnlineBook', () => reader.searchOnlineBook()),
    vscode.commands.registerCommand('maskRead.openOnlineBook', (reference) => reader.openOnlineBook(reference, true)),
    vscode.commands.registerCommand('maskRead.removeFromShelf', (item: BookShelfItem | string) => {
      if (typeof item === 'string') {
        void reader.removeFromShelf({ id: item, title: item, filePath: item });
      } else if (item?.entry) {
        void reader.removeFromShelf(item.entry);
      }
    }),
    vscode.commands.registerCommand('maskRead.toggleLine', () => reader.toggleLine()),
    vscode.commands.registerCommand('maskRead.moveLineUp', () => reader.moveLine(-1)),
    vscode.commands.registerCommand('maskRead.moveLineDown', () => reader.moveLine(1)),
    vscode.commands.registerCommand('maskRead.nextChapter', () => reader.nextChapter()),
    vscode.commands.registerCommand('maskRead.previousChapter', () => reader.previousChapter()),
    vscode.commands.registerCommand('maskRead.closeBook', () => reader.closeBook()),
    vscode.commands.registerCommand('maskRead.jumpToChapter', (chapterId: string) => reader.jumpToChapter(chapterId))
  );

  void vscode.commands.executeCommand('setContext', 'maskRead.hasBook', false);
  void reader.restoreLastBook();
}

export function deactivate(): void {
  // Resources are owned by ExtensionContext subscriptions.
}
