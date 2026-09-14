const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

const { parseBook } = require('../dist/parsers');
const { getReadableLines } = require('../dist/line-utils');
const { splitTextIntoChapters } = require('../dist/parsers/text');

async function writeEpub(directory) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="2.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试 EPUB</dc:title></metadata>
      <manifest>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/>
        <item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine toc="ncx"><itemref idref="one"/><itemref idref="two"/></spine>
    </package>`);
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0"?>
    <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
      <navMap>
        <navPoint><navLabel><text>第一章</text></navLabel><content src="text/one.xhtml"/></navPoint>
        <navPoint><navLabel><text>第二章</text></navLabel><content src="text/two.xhtml"/></navPoint>
      </navMap>
    </ncx>`);
  zip.file('OEBPS/text/one.xhtml', '<html><body><h1>第一章</h1><p>你好，EPUB。</p></body></html>');
  zip.file('OEBPS/text/two.xhtml', '<html><body><h1>第二章</h1><p>这是第二章。</p></body></html>');
  const filePath = path.join(directory, 'sample.epub');
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return filePath;
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'console-reader-'));
  const textPath = path.join(directory, 'sample.txt');
  await fs.writeFile(textPath, '序章\n开始\n\n第一章 初遇\n故事开始\n\n第二章 继续\n故事继续', 'utf8');

  const textBook = await parseBook(textPath);
  assert.equal(textBook.format, 'text');
  assert.equal(textBook.chapters.length, 3);
  assert.match(textBook.chapters[1].content, /第一章/);

  const chapters = splitTextIntoChapters('Chapter 1\nHello\n\nChapter 2\nWorld', 'Book');
  assert.equal(chapters.length, 2);

  assert.deepEqual(getReadableLines('\n第一行\n\n  \n第二行\n'), [
    { rawIndex: 1, text: '第一行' },
    { rawIndex: 4, text: '第二行' }
  ]);

  const epubPath = await writeEpub(directory);
  const epubBook = await parseBook(epubPath);
  assert.equal(epubBook.title, '测试 EPUB');
  assert.equal(epubBook.chapters.length, 2);
  assert.equal(epubBook.chapters[0].title, '第一章');
  assert.match(epubBook.text, /这是第二章/);

  const htmlPath = path.join(directory, 'sample.html');
  await fs.writeFile(htmlPath, '<html><head><title>HTML 书</title></head><body><h1>第一章</h1><p>网页正文</p></body></html>');
  const htmlBook = await parseBook(htmlPath);
  assert.equal(htmlBook.title, 'HTML 书');
  assert.match(htmlBook.text, /网页正文/);

  const fb2Path = path.join(directory, 'sample.fb2');
  await fs.writeFile(fb2Path, '<FictionBook><description><title-info><book-title>FB2 书</book-title></title-info></description><body><section><title><p>第一章</p></title><p>FB2 正文</p></section></body></FictionBook>');
  const fb2Book = await parseBook(fb2Path);
  assert.equal(fb2Book.title, 'FB2 书');
  assert.equal(fb2Book.chapters[0].title, '第一章');
  assert.match(fb2Book.text, /FB2 正文/);

  const docxPath = path.join(directory, 'sample.docx');
  const docx = new JSZip();
  docx.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一章</w:t></w:r></w:p><w:p><w:r><w:t>DOCX 正文</w:t></w:r></w:p></w:body></w:document>');
  docx.file('docProps/core.xml', '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>DOCX 书</dc:title></cp:coreProperties>');
  await fs.writeFile(docxPath, await docx.generateAsync({ type: 'nodebuffer' }));
  const docxBook = await parseBook(docxPath);
  assert.equal(docxBook.title, 'DOCX 书');
  assert.match(docxBook.text, /DOCX 正文/);

  const pdfPath = path.join(directory, 'sample.pdf');
  const stream = 'BT\n/F1 24 Tf\n100 700 Td\n(Hello PDF) Tj\nET\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  await fs.writeFile(pdfPath, pdf);
  const pdfBook = await parseBook(pdfPath);
  assert.equal(pdfBook.format, 'pdf');
  assert.match(pdfBook.text, /Hello PDF/);

  await fs.rm(directory, { recursive: true, force: true });
  console.log('unit tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
