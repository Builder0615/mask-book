export type BookFormat = 'epub' | 'fb2' | 'pdf' | 'docx' | 'odt' | 'text' | 'html' | 'markdown' | 'rtf' | 'subtitle';

export interface Chapter {
  id: string;
  title: string;
  content: string;
  source?: string;
}

export interface Book {
  filePath: string;
  title: string;
  format: BookFormat;
  chapters: Chapter[];
  text: string;
}

export type TextEncoding = 'auto' | 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be';

export const SUPPORTED_EXTENSIONS = [
  'epub',
  'fb2',
  'pdf',
  'docx',
  'odt',
  'txt',
  'text',
  'novel',
  'md',
  'markdown',
  'rst',
  'adoc',
  'org',
  'html',
  'htm',
  'xhtml',
  'xml',
  'rtf',
  'srt',
  'vtt',
  'ass',
  'ssa',
  'log'
] as const;

export function extensionOf(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot <= lastSlash) {
    return '';
  }
  return filePath.slice(lastDot + 1).toLowerCase();
}

export function isSupportedFile(filePath: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(filePath));
}
