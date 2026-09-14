import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import { DOMParser, Document, Element } from '@xmldom/xmldom';
import { Book, Chapter } from '../types';
import { extractMarkupText, normalizeMarkupText } from './markup';

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

interface TocEntry {
  title: string;
  target: string;
}

export async function parseEpubBook(filePath: string): Promise<Book> {
  const archive = await JSZip.loadAsync(await fs.readFile(filePath));
  const container = await readZipText(archive, 'META-INF/container.xml');
  if (!container) {
    throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  }

  const containerDocument = parseXml(container, 'container.xml');
  const rootFile = firstElement(containerDocument, 'rootfile');
  const opfPath = rootFile?.getAttribute('full-path');
  if (!opfPath) {
    throw new Error('不是有效的 EPUB：找不到 OPF 文件');
  }

  const normalizedOpfPath = normalizeZipPath(opfPath);
  const opf = await readZipText(archive, normalizedOpfPath);
  if (!opf) {
    throw new Error(`EPUB 缺少 OPF 文件：${normalizedOpfPath}`);
  }

  const opfDocument = parseXml(opf, normalizedOpfPath);
  const manifest = parseManifest(opfDocument);
  const spine = firstElement(opfDocument, 'spine');
  const spineItems = parseSpine(spine, manifest);
  if (spineItems.length === 0) {
    throw new Error('EPUB 的 spine 没有可读取的章节');
  }

  const tocEntries = await parseToc(archive, opfDocument, manifest, spine, normalizedOpfPath);
  const title = findMetadata(opfDocument, 'title') || path.basename(filePath, path.extname(filePath));
  const chapters: Chapter[] = [];

  for (let index = 0; index < spineItems.length; index += 1) {
    const item = spineItems[index];
    const chapterPath = resolveZipHref(normalizedOpfPath, item.href);
    const chapterSource = await readZipText(archive, chapterPath);
    if (!chapterSource) {
      continue;
    }

    const chapterDocument = parseXml(chapterSource, chapterPath);
    const body = firstElement(chapterDocument, 'body') ?? chapterDocument.documentElement;
    if (!body) {
      continue;
    }
    const content = normalizeMarkupText(extractMarkupText(body));
    if (!content) {
      continue;
    }

    const chapterTitle = tocEntries.get(chapterPath)
      || findHeading(chapterDocument)
      || `第 ${index + 1} 章`;
    chapters.push({
      id: `chapter-${chapters.length + 1}`,
      title: chapterTitle,
      content,
      source: chapterPath
    });
  }

  if (chapters.length === 0) {
    throw new Error('EPUB 中没有提取到可显示的正文');
  }

  return {
    filePath,
    title: title || '未命名 EPUB',
    format: 'epub',
    chapters,
    text: chapters.map(chapter => `${chapter.title}\n\n${chapter.content}`).join('\n\n')
  };
}

function parseManifest(document: Document): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>();
  const items = document.getElementsByTagName('item');
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) {
      continue;
    }
    manifest.set(id, {
      id,
      href,
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || ''
    });
  }
  return manifest;
}

function parseSpine(spine: Element | undefined, manifest: Map<string, ManifestItem>): ManifestItem[] {
  if (!spine) {
    return [];
  }
  const itemRefs = spine.getElementsByTagName('itemref');
  const result: ManifestItem[] = [];
  for (let index = 0; index < itemRefs.length; index += 1) {
    const itemRef = itemRefs[index];
    if (itemRef.getAttribute('linear') === 'no') {
      continue;
    }
    const idref = itemRef.getAttribute('idref');
    const item = idref ? manifest.get(idref) : undefined;
    if (item && isReadableMarkup(item.mediaType)) {
      result.push(item);
    }
  }
  return result;
}

async function parseToc(
  archive: JSZip,
  opfDocument: Document,
  manifest: Map<string, ManifestItem>,
  spine: Element | undefined,
  opfPath: string
): Promise<Map<string, string>> {
  const toc = new Map<string, string>();
  const navItem = Array.from(manifest.values()).find(item => item.properties.split(/\s+/).includes('nav'));
  if (navItem) {
    const navPath = resolveZipHref(opfPath, navItem.href);
    const navSource = await readZipText(archive, navPath);
    if (navSource) {
      const document = parseXml(navSource, navPath);
      const nav = findTocNav(document) ?? firstElement(document, 'nav');
      if (nav) {
        const links = nav.getElementsByTagName('a');
        for (let index = 0; index < links.length; index += 1) {
          const href = links[index].getAttribute('href');
          const title = links[index].textContent?.trim();
          if (href && title) {
            toc.set(resolveZipHref(navPath, href), title);
          }
        }
      }
    }
  }

  if (toc.size > 0) {
    return toc;
  }

  const tocId = spine?.getAttribute('toc');
  const ncxItem = tocId
    ? manifest.get(tocId)
    : Array.from(manifest.values()).find(item => item.mediaType === 'application/x-dtbncx+xml');
  if (!ncxItem) {
    return toc;
  }

  const ncxPath = resolveZipHref(opfPath, ncxItem.href);
  const ncxSource = await readZipText(archive, ncxPath);
  if (!ncxSource) {
    return toc;
  }
  const ncxDocument = parseXml(ncxSource, ncxPath);
  const navPoints = ncxDocument.getElementsByTagName('navPoint');
  for (let index = 0; index < navPoints.length; index += 1) {
    const navPoint = navPoints[index];
    const content = firstElement(navPoint, 'content');
    const label = firstElement(navPoint, 'text');
    const src = content?.getAttribute('src');
    const title = label?.textContent?.trim();
    if (src && title) {
      toc.set(resolveZipHref(ncxPath, src), title);
    }
  }
  return toc;
}

function findTocNav(document: Document): Element | undefined {
  const navs = document.getElementsByTagName('nav');
  for (let index = 0; index < navs.length; index += 1) {
    const nav = navs[index];
    const type = `${nav.getAttribute('epub:type') || ''} ${nav.getAttribute('type') || ''}`.toLowerCase();
    if (type.split(/\s+/).includes('toc')) {
      return nav;
    }
  }
  return undefined;
}

function findHeading(document: Document): string | undefined {
  for (const tagName of ['h1', 'h2', 'h3', 'title']) {
    const element = firstElement(document, tagName);
    const value = element?.textContent?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function findMetadata(document: Document, localName: string): string | undefined {
  const candidates = [
    ...Array.from(document.getElementsByTagName(`dc:${localName}`)),
    ...Array.from(document.getElementsByTagName(localName))
  ];
  return candidates.map(element => element.textContent?.trim()).find(Boolean);
}

function firstElement(root: Document | Element, tagName: string): Element | undefined {
  const elements = root.getElementsByTagName(tagName);
  return elements.length > 0 ? elements[0] : undefined;
}

function isReadableMarkup(mediaType: string): boolean {
  return mediaType === 'application/xhtml+xml'
    || mediaType === 'text/html'
    || mediaType === 'application/xml'
    || mediaType === 'text/xml'
    || mediaType.endsWith('+html');
}

function parseXml(value: string, sourceName: string): Document {
  return new DOMParser({
    onError: (level, message) => {
      if (level === 'fatalError') {
        throw new Error(`无法解析 EPUB 文件 ${sourceName}：${message}`);
      }
    }
  }).parseFromString(value, 'application/xml');
}

async function readZipText(archive: JSZip, filePath: string): Promise<string | undefined> {
  const entry = findZipEntry(archive, filePath);
  return entry ? entry.async('string') : undefined;
}

function findZipEntry(archive: JSZip, filePath: string): JSZip.JSZipObject | undefined {
  const wanted = normalizeZipPath(filePath);
  const exact = archive.file(wanted);
  if (exact) {
    return exact;
  }
  const pair = Object.entries(archive.files).find(([name]) => normalizeZipPath(name) === wanted);
  return pair?.[1];
}

function resolveZipHref(basePath: string, href: string): string {
  const withoutFragment = href.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) {
    return normalizeZipPath(basePath);
  }
  return normalizeZipPath(path.posix.join(path.posix.dirname(basePath), decodeURIComponent(withoutFragment)));
}

function normalizeZipPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}
