import * as vscode from 'vscode';
import { BookShelfItem } from './bookshelf';
import { ReaderController } from './reader';

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
  context.subscriptions.push(chapterView);

  context.subscriptions.push(
    vscode.commands.registerCommand('consoleReader.addBook', () => reader.addBook()),
    vscode.commands.registerCommand('consoleReader.openPath', (filePath: string) => reader.openPath(filePath, true)),
    vscode.commands.registerCommand('consoleReader.removeFromShelf', (item: BookShelfItem | string) => {
      const filePath = typeof item === 'string' ? item : item?.filePath;
      if (filePath) {
        void reader.removeFromShelf(filePath);
      }
    }),
    vscode.commands.registerCommand('consoleReader.toggleLine', () => reader.toggleLine()),
    vscode.commands.registerCommand('consoleReader.moveLineUp', () => reader.moveLine(-1)),
    vscode.commands.registerCommand('consoleReader.moveLineDown', () => reader.moveLine(1)),
    vscode.commands.registerCommand('consoleReader.nextChapter', () => reader.nextChapter()),
    vscode.commands.registerCommand('consoleReader.previousChapter', () => reader.previousChapter()),
    vscode.commands.registerCommand('consoleReader.closeBook', () => reader.closeBook()),
    vscode.commands.registerCommand('consoleReader.jumpToChapter', (chapterId: string) => reader.jumpToChapter(chapterId))
  );

  void vscode.commands.executeCommand('setContext', 'consoleReader.hasBook', false);
  void reader.restoreLastBook();
}

export function deactivate(): void {
  // Resources are owned by ExtensionContext subscriptions.
}
