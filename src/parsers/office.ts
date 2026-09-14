import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import { DOMParser, Document, Element } from '@xmldom/xmldom';
import { Book, BookFormat } from '../types';
import { extractMarkupText, normalizeMarkupText } from './markup';
import { splitTextIntoChapters } from './text';

export async function parseOfficeBook(filePath: string, format: Extract<BookFormat, 'docx' | 'odt'>): Promise<Book> {
  const archive = await JSZip.loadAsync(await fs.readFile(filePath));
  const contentPath = format === 'docx' ? 'word/document.xml' : 'content.xml';
  const contentSource = await readZipText(archive, contentPath);
  if (!contentSource) {
    throw new Error(`${format.toUpperCase()} 文件缺少 ${contentPath}`);
  }

  const document = parseXml(contentSource, contentPath);
  const paragraphs = findElementsByLocalName(document, 'p')
    .map(element => normalizeMarkupText(extractMarkupText(element)))
    .filter(Boolean);
  const text = paragraphs.join('\n\n');
  const metadataSource = format === 'docx'
    ? await readZipText(archive, 'docProps/core.xml')
    : contentSource;
  const title = metadataSource
    ? extractTitle(parseXml(metadataSource, format === 'docx' ? 'docProps/core.xml' : contentPath))
    : undefined;
  const finalTitle = title || path.basename(filePath, path.extname(filePath));
  const chapters = splitTextIntoChapters(text, finalTitle || '未命名文档');

  return {
    filePath,
    title: finalTitle || '未命名文档',
    format,
    chapters,
    text: text || '（文档没有可显示的文本内容）'
  };
}

function findElementsByLocalName(document: Document, localName: string): Element[] {
  return Array.from(document.getElementsByTagName('*')).filter(element => elementLocalName(element) === localName);
}

function elementLocalName(element: Element): string {
  return (element.localName || element.tagName).split(':').pop()?.toLowerCase() || '';
}

function extractTitle(document: Document): string | undefined {
  const titleElements = [
    ...Array.from(document.getElementsByTagName('dc:title')),
    ...Array.from(document.getElementsByTagName('title'))
  ];
  return titleElements.map(element => element.textContent?.trim()).find(Boolean);
}

function parseXml(value: string, sourceName: string): Document {
  return new DOMParser({
    onError: (level, message) => {
      if (level === 'fatalError') {
        throw new Error(`无法解析 ${sourceName}：${message}`);
      }
    }
  }).parseFromString(value, 'application/xml');
}

async function readZipText(archive: JSZip, filePath: string): Promise<string | undefined> {
  const entry = archive.file(filePath);
  return entry ? entry.async('string') : undefined;
}
