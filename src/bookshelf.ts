import * as path from 'node:path';
import * as vscode from 'vscode';
import { OnlineBookReference } from './types';

export interface BookShelfEntry {
  id: string;
  title: string;
  description?: string;
  filePath?: string;
  onlineBook?: OnlineBookReference;
}

export interface BookShelfViewCallbacks {
  removeFromShelf(entry: BookShelfEntry): void;
}

export class BookShelfItem extends vscode.TreeItem {
  public readonly entry: BookShelfEntry;
  public readonly filePath: string | undefined;

  public constructor(entry: BookShelfEntry) {
    super(entry.title, vscode.TreeItemCollapsibleState.None);
    this.entry = entry;
    this.filePath = entry.filePath;
    this.id = entry.id;
    this.tooltip = entry.onlineBook
      ? `${entry.title}\n${entry.onlineBook.author || ''}\n${entry.onlineBook.bookUrl}`
      : entry.filePath;
    this.description = entry.description;
    this.contextValue = 'maskRead.book';
    this.iconPath = new vscode.ThemeIcon(entry.onlineBook ? 'cloud-download' : 'book');
    this.command = {
      command: entry.onlineBook ? 'maskRead.openOnlineBook' : 'maskRead.openPath',
      title: entry.onlineBook ? '打开在线书籍' : '打开书籍',
      arguments: [entry.onlineBook || entry.filePath, true]
    };
  }
}

export class BookShelfProvider implements vscode.TreeDataProvider<BookShelfItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<BookShelfItem[] | undefined>();
  private entries: BookShelfEntry[] = [];

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly callbacks: BookShelfViewCallbacks) {}

  public setPaths(paths: string[]): void {
    this.setEntries(paths.map(filePath => ({
      id: filePath,
      title: path.basename(filePath),
      description: path.dirname(filePath),
      filePath
    })));
  }

  public setEntries(entries: BookShelfEntry[]): void {
    this.entries = [...entries];
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(element: BookShelfItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: BookShelfItem): vscode.ProviderResult<BookShelfItem[]> {
    if (element) {
      return [];
    }
    return this.entries.map(entry => new BookShelfItem(entry));
  }

  public remove(entry: BookShelfEntry): void {
    this.callbacks.removeFromShelf(entry);
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}
