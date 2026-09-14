import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import pdfParse = require('pdf-parse');
import { Book } from '../types';
import { normalizePlainText, splitTextIntoChapters } from './text';

export async function parsePdfBook(filePath: string): Promise<Book> {
  // pdf-parse 1.x has a Node Buffer/XRef edge case after archive parsers ran.
  // Passing a plain Uint8Array keeps the PDF.js input path deterministic.
  const result = await pdfParse(Uint8Array.from(await fs.readFile(filePath)));
  const text = normalizePlainText(result.text.replace(/\f/g, '\n\n'));
  const metadataTitle = result.info?.Title;
  const title = typeof metadataTitle === 'string' && metadataTitle.trim()
    ? metadataTitle.trim()
    : path.basename(filePath, path.extname(filePath));
  const chapters = splitTextIntoChapters(text, title || '未命名 PDF');

  return {
    filePath,
    title: title || '未命名 PDF',
    format: 'pdf',
    chapters,
    text: text || '（PDF 没有可提取的文本；扫描版 PDF 需要 OCR）'
  };
}
