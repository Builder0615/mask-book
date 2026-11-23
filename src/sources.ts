import * as vscode from 'vscode';
import type { LegadoBookSource } from './online';
import type { BookSourceSubscription } from './types';

export type SourceTreeNode =
  | { kind: 'selectAll'; count: number; selectedCount: number }
  | { kind: 'bookSources'; count: number }
  | { kind: 'subscriptions'; count: number }
  | { kind: 'bookSource'; source: LegadoBookSource }
  | { kind: 'subscription'; subscription: BookSourceSubscription };

export class SourceTreeItem extends vscode.TreeItem {
  public readonly node: SourceTreeNode;

  public constructor(node: SourceTreeNode, checked = false) {
    if (node.kind === 'selectAll') {
      super('全选', vscode.TreeItemCollapsibleState.None);
      this.description = `${node.selectedCount}/${node.count}`;
      this.contextValue = 'maskRead.sourceSelectAll';
      this.iconPath = new vscode.ThemeIcon('check-all');
      this.checkboxState = checked
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    } else if (node.kind === 'bookSources') {
      super(`书源 (${node.count})`, vscode.TreeItemCollapsibleState.Expanded);
      this.contextValue = 'maskRead.sourceGroup';
      this.iconPath = new vscode.ThemeIcon('book');
    } else if (node.kind === 'subscriptions') {
      super(`订阅源 (${node.count})`, vscode.TreeItemCollapsibleState.Expanded);
      this.contextValue = 'maskRead.sourceGroup';
      this.iconPath = new vscode.ThemeIcon('rss');
    } else if (node.kind === 'bookSource') {
      const source = node.source;
      super(source.bookSourceName || source.bookSourceUrl, vscode.TreeItemCollapsibleState.None);
      this.id = `bookSource:${source.bookSourceUrl}`;
      this.description = [
        source.enabled === false ? '已停用' : '已启用',
        source.bookSourceGroup
      ].filter(Boolean).join(' · ');
      this.tooltip = `${source.bookSourceName || source.bookSourceUrl}\n${source.bookSourceUrl}`;
      this.contextValue = 'maskRead.bookSource';
      this.iconPath = new vscode.ThemeIcon(source.enabled === false ? 'circle-slash' : 'book');
      this.checkboxState = checked
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      this.command = {
        command: 'maskRead.openSourceUrl',
        title: '打开书源地址',
        arguments: [source.bookSourceUrl]
      };
    } else {
      const subscription = node.subscription;
      super(subscription.name, vscode.TreeItemCollapsibleState.None);
      this.id = `subscription:${subscription.id}`;
      this.description = [
        `${subscription.sourceUrls.length} 个书源`,
        formatUpdatedAt(subscription.updatedAt)
      ].filter(Boolean).join(' · ');
      this.tooltip = `${subscription.name}\n${subscription.url}`;
      this.contextValue = 'maskRead.sourceSubscription';
      this.iconPath = new vscode.ThemeIcon('rss');
      this.checkboxState = checked
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      this.command = {
        command: 'maskRead.openSourceUrl',
        title: '打开订阅源地址',
        arguments: [subscription.url]
      };
    }

    this.node = node;
  }
}

export class SourceTreeProvider implements vscode.TreeDataProvider<SourceTreeItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<SourceTreeItem[] | undefined>();
  private sources: LegadoBookSource[] = [];
  private subscriptions: BookSourceSubscription[] = [];
  private checkedKeys = new Set<string>();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public setSources(sources: readonly LegadoBookSource[], subscriptions: readonly BookSourceSubscription[]): void {
    this.sources = [...sources];
    this.subscriptions = [...subscriptions];
    const availableKeys = new Set(this.getLeafKeys());
    this.checkedKeys = new Set([...this.checkedKeys].filter(key => availableKeys.has(key)));
    this.changeEmitter.fire(undefined);
  }

  public setCheckedState(items: ReadonlyArray<[SourceTreeItem, vscode.TreeItemCheckboxState]>): void {
    let changed = false;
    for (const [item, state] of items) {
      if (item.node.kind === 'selectAll') {
        const next = state === vscode.TreeItemCheckboxState.Checked
          ? new Set(this.getLeafKeys())
          : new Set<string>();
        changed = changed || !areSetsEqual(this.checkedKeys, next);
        this.checkedKeys = next;
        continue;
      }
      const key = sourceTreeNodeKey(item.node);
      if (!key) {
        continue;
      }
      if (state === vscode.TreeItemCheckboxState.Checked) {
        changed = changed || !this.checkedKeys.has(key);
        this.checkedKeys.add(key);
      } else {
        changed = changed || this.checkedKeys.has(key);
        this.checkedKeys.delete(key);
      }
    }
    if (changed) {
      this.changeEmitter.fire(undefined);
    }
  }

  public selectAll(): void {
    this.checkedKeys = new Set(this.getLeafKeys());
    this.changeEmitter.fire(undefined);
  }

  public clearSelection(): void {
    if (this.checkedKeys.size === 0) {
      return;
    }
    this.checkedKeys.clear();
    this.changeEmitter.fire(undefined);
  }

  public getCheckedItems(): SourceTreeItem[] {
    return [
      ...this.sources
        .filter(source => this.checkedKeys.has(sourceTreeNodeKey({ kind: 'bookSource', source })!))
        .map(source => new SourceTreeItem({ kind: 'bookSource', source }, true)),
      ...this.subscriptions
        .filter(subscription => this.checkedKeys.has(sourceTreeNodeKey({ kind: 'subscription', subscription })!))
        .map(subscription => new SourceTreeItem({ kind: 'subscription', subscription }, true))
    ];
  }

  public getTreeItem(element: SourceTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: SourceTreeItem): SourceTreeItem[] {
    if (!element) {
      const leafKeys = this.getLeafKeys();
      if (leafKeys.length === 0) {
        return [];
      }
      return [
        new SourceTreeItem({
          kind: 'selectAll',
          count: leafKeys.length,
          selectedCount: this.checkedKeys.size
        }, this.checkedKeys.size === leafKeys.length),
        new SourceTreeItem({ kind: 'bookSources', count: this.sources.length }),
        new SourceTreeItem({ kind: 'subscriptions', count: this.subscriptions.length })
      ];
    }

    if (element.node.kind === 'bookSources') {
      return this.sources.map(source => new SourceTreeItem(
        { kind: 'bookSource', source },
        this.checkedKeys.has(sourceTreeNodeKey({ kind: 'bookSource', source })!)
      ));
    }
    if (element.node.kind === 'subscriptions') {
      return this.subscriptions.map(subscription => new SourceTreeItem(
        { kind: 'subscription', subscription },
        this.checkedKeys.has(sourceTreeNodeKey({ kind: 'subscription', subscription })!)
      ));
    }
    return [];
  }

  private getLeafKeys(): string[] {
    return [...new Set([
      ...this.sources.map(source => sourceTreeNodeKey({ kind: 'bookSource', source })),
      ...this.subscriptions.map(subscription => sourceTreeNodeKey({ kind: 'subscription', subscription }))
    ].filter((key): key is string => Boolean(key)))];
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

function formatUpdatedAt(updatedAt: string | undefined): string | undefined {
  if (!updatedAt) {
    return undefined;
  }
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime()) ? undefined : `更新于 ${date.toLocaleString()}`;
}

function sourceTreeNodeKey(node: SourceTreeNode): string | undefined {
  if (node.kind === 'bookSource') {
    return `bookSource:${node.source.bookSourceUrl}`;
  }
  if (node.kind === 'subscription') {
    return `subscription:${node.subscription.id}`;
  }
  return undefined;
}

function areSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}
