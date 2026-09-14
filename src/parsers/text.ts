import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as iconv from 'iconv-lite';
import { Book, BookFormat, Chapter, TextEncoding } from '../types';

const CHAPTER_PATTERNS = [
  /^\s*(?:第\s*[0-9０-９一二三四五六七八九十百千万零〇两廿卅]+\s*[章节卷集部篇回].*)$/i,
  /^\s*(?:(?:chapter|chap\.?|part|prologue|epilogue)\b.*|(?:序章|楔子|引子|番外|尾声|前言|后记).*)$/i
];

export async function parseTextBook(
  filePath: string,
  configuredEncoding: TextEncoding = 'auto',
  format: BookFormat = formatForTextExtension(filePath)
): Promise<Book> {
  const buffer = await fs.readFile(filePath);
  const rawText = decodeText(buffer, configuredEncoding);
  const text = normalizePlainText(rawText);
  const title = titleFromPath(filePath);
  const chapters = splitTextIntoChapters(text, title);

  return {
    filePath,
    title,
    format,
    chapters,
    text: text || '（文件没有可显示的文本内容）'
  };
}

export function decodeText(buffer: Buffer, configuredEncoding: TextEncoding = 'auto'): string {
  if (configuredEncoding !== 'auto') {
    return stripBom(iconv.decode(buffer, encodingName(configuredEncoding)));
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return stripBom(iconv.decode(buffer, 'utf16-le'));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return stripBom(iconv.decode(buffer, 'utf16-be'));
  }

  const utf8 = buffer.toString('utf8');
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  const nonWhitespaceCount = utf8.replace(/\s/g, '').length;

  // A GBK/GB18030 file decoded as UTF-8 usually contains replacement characters.
  // Only fall back when the signal is meaningful, so normal UTF-8 files are untouched.
  if (replacementCount > 0 && replacementCount >= Math.max(1, nonWhitespaceCount * 0.005)) {
    return iconv.decode(buffer, 'gb18030');
  }
  return utf8;
}

export function normalizePlainText(value: string): string {
  return value
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitTextIntoChapters(text: string, bookTitle: string): Chapter[] {
  if (!text) {
    return [{ id: 'chapter-1', title: bookTitle, content: '' }];
  }

  const lines = text.split('\n');
  const headings: Array<{ line: number; title: string }> = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim().replace(/^={2,}|={2,}$/g, '').trim();
    if (trimmed.length > 120 || trimmed.length === 0) {
      return;
    }
    if (CHAPTER_PATTERNS.some(pattern => pattern.test(trimmed))) {
      headings.push({ line: index, title: trimmed });
    }
  });

  if (headings.length === 0) {
    return [{ id: 'chapter-1', title: bookTitle, content: text }];
  }

  return headings.map((heading, index) => {
    const end = headings[index + 1]?.line ?? lines.length;
    return {
      id: `chapter-${index + 1}`,
      title: heading.title,
      content: lines.slice(heading.line, end).join('\n').trim()
    };
  });
}

function encodingName(encoding: Exclude<TextEncoding, 'auto'>): string {
  switch (encoding) {
    case 'utf-16le':
      return 'utf16-le';
    case 'utf-16be':
      return 'utf16-be';
    default:
      return encoding;
  }
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, '');
}

function formatForTextExtension(filePath: string): BookFormat {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html' || extension === '.htm' || extension === '.xhtml' || extension === '.xml') {
    return 'html';
  }
  if (extension === '.md' || extension === '.markdown' || extension === '.rst' || extension === '.adoc' || extension === '.org') {
    return 'markdown';
  }
  if (extension === '.rtf') {
    return 'rtf';
  }
  if (extension === '.srt' || extension === '.vtt' || extension === '.ass' || extension === '.ssa') {
    return 'subtitle';
  }
  return 'text';
}

function titleFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)) || '未命名书籍';
}
