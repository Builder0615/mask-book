import { DOMParser, Document, Element, Node } from '@xmldom/xmldom';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { Book, Chapter } from '../types';
import { decodeText, normalizePlainText, splitTextIntoChapters } from './text';

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul'
]);

export async function parseMarkupBook(filePath: string): Promise<Book> {
  const input = await fs.readFile(filePath);
  const document = parseMarkup(decodeText(input), filePath);
  const root = firstElement(document, 'body') ?? document.documentElement;
  if (!root) {
    throw new Error(`无法解析 ${filePath}：文档为空`);
  }
  const text = extractMarkupText(root);
  const title = extractDocumentTitle(document) || path.basename(filePath, path.extname(filePath));
  const chapters = splitTextIntoChapters(text, title || '未命名书籍');

  return {
    filePath,
    title: title || '未命名书籍',
    format: 'html',
    chapters,
    text: text || '（文件没有可显示的文本内容）'
  };
}

export function extractMarkupText(root: Node): string {
  const chunks: string[] = [];

  const visit = (node: Node): void => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      chunks.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9) {
      return;
    }

    const element = node.nodeType === 1 ? node as Element : undefined;
    const tagName = element ? (element.localName || element.tagName).split(':').pop()?.toLowerCase() : undefined;
    if (tagName === 'script' || tagName === 'style' || tagName === 'noscript' || tagName === 'svg') {
      return;
    }
    if (tagName === 'br') {
      chunks.push('\n');
      return;
    }

    const isBlock = tagName ? BLOCK_TAGS.has(tagName) : false;
    if (isBlock) {
      chunks.push('\n');
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child);
    }
    if (isBlock) {
      chunks.push('\n');
    }
  };

  visit(root);
  return normalizeMarkupText(chunks.join(''));
}

export function parseMarkup(value: string, sourceName: string): Document {
  return new DOMParser({
    onError: (level, message) => {
      if (level === 'fatalError') {
        throw new Error(`无法解析 ${sourceName}：${message}`);
      }
    }
  }).parseFromString(value, 'text/html');
}

export function normalizeMarkupText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim();
}

function firstElement(root: Document | Element, tagName: string): Element | undefined {
  const elements = root.getElementsByTagName(tagName);
  return elements.length > 0 ? elements[0] : undefined;
}

function extractDocumentTitle(document: Document): string | undefined {
  const titleElement = firstElement(document, 'title');
  const title = titleElement?.textContent?.trim();
  return title || undefined;
}
