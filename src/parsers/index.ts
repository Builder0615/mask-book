import { parseEpubBook } from './epub';
import { parseFb2Book } from './fb2';
import { parseMarkupBook } from './markup';
import { parseOfficeBook } from './office';
import { parsePdfBook } from './pdf';
import { parseTextBook } from './text';
import { Book, extensionOf, isSupportedFile, TextEncoding } from '../types';

export async function parseBook(filePath: string, textEncoding: TextEncoding = 'auto'): Promise<Book> {
  const extension = extensionOf(filePath);
  if (!isSupportedFile(filePath)) {
    throw new Error(`暂不支持 .${extension || 'unknown'} 格式。`);
  }

  switch (extension) {
    case 'epub':
      return parseEpubBook(filePath);
    case 'fb2':
      return parseFb2Book(filePath);
    case 'pdf':
      return parsePdfBook(filePath);
    case 'docx':
      return parseOfficeBook(filePath, 'docx');
    case 'odt':
      return parseOfficeBook(filePath, 'odt');
    case 'html':
    case 'htm':
    case 'xhtml':
    case 'xml':
      return parseMarkupBook(filePath);
    default:
      return parseTextBook(filePath, textEncoding);
  }
}

export { parseEpubBook } from './epub';
export { parseFb2Book } from './fb2';
export { parseMarkupBook } from './markup';
export { parseOfficeBook } from './office';
export { parsePdfBook } from './pdf';
export { parseTextBook, splitTextIntoChapters } from './text';
