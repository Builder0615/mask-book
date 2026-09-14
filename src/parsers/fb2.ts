import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { DOMParser, Document, Element } from '@xmldom/xmldom';
import { Book, Chapter } from '../types';
import { decodeText } from './text';
import { extractMarkupText, normalizeMarkupText } from './markup';

export async function parseFb2Book(filePath: string): Promise<Book> {
  const buffer = await fs.readFile(filePath);
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === 'fatalError') {
        throw new Error(`无法解析 FB2：${message}`);
      }
    }
  }).parseFromString(decodeText(buffer), 'application/xml');

  const title = firstText(document, 'book-title') || path.basename(filePath, path.extname(filePath));
  const sections = Array.from(document.getElementsByTagName('section'));
  const topLevelSections = sections.filter(section => section.parentNode?.nodeName.toLowerCase() !== 'section');
  const sourceSections = topLevelSections.length > 0 ? topLevelSections : sections;
  const chapters: Chapter[] = sourceSections.map((section, index) => {
    const sectionTitle = firstText(section, 'title') || `第 ${index + 1} 章`;
    const content = normalizeMarkupText(extractMarkupText(section));
    return {
      id: `chapter-${index + 1}`,
      title: sectionTitle,
      content,
      source: 'FB2 section'
    };
  }).filter(chapter => chapter.content.length > 0);

  const finalChapters = chapters.length > 0
    ? chapters
    : [{ id: 'chapter-1', title, content: normalizeMarkupText(extractMarkupText(document)) }];

  return {
    filePath,
    title: title || '未命名书籍',
    format: 'fb2',
    chapters: finalChapters,
    text: finalChapters.map(chapter => `${chapter.title}\n\n${chapter.content}`).join('\n\n')
  };
}

function firstText(root: Document | Element, tagName: string): string | undefined {
  const elements = root.getElementsByTagName(tagName);
  for (let index = 0; index < elements.length; index += 1) {
    const value = elements[index].textContent?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}
