import * as path from 'node:path';
import * as vscode from 'vscode';

export interface BookShelfViewCallbacks {
  removeFromShelf(filePath: string): void;
}

export class BookShelfItem extends vscode.TreeItem {
  public readonly filePath: string;

  public constructor(filePath: string) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    this.filePath = filePath;
    this.id = filePath;
    this.tooltip = filePath;
    this.description = path.dirname(filePath);
    this.contextValue = 'consoleReader.book';
    this.iconPath = new vscode.ThemeIcon('book');
    this.command = {
      command: 'consoleReader.openPath',
      title: '打开书籍',
      arguments: [filePath, true]
    };
  }
}

export class BookShelfProvider implements vscode.TreeDataProvider<BookShelfItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<BookShelfItem[] | undefined>();
  private paths: string[] = [];

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly callbacks: BookShelfViewCallbacks) {}

  public setPaths(paths: string[]): void {
    this.paths = [...paths];
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(element: BookShelfItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: BookShelfItem): vscode.ProviderResult<BookShelfItem[]> {
    if (element) {
      return [];
    }
    return this.paths.map(filePath => new BookShelfItem(filePath));
  }

  public remove(filePath: string): void {
    this.callbacks.removeFromShelf(filePath);
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}
