const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

const { parseBook } = require('../dist/parsers');
const { getDisplayLines, getReadableLines } = require('../dist/line-utils');
const { splitTextIntoChapters } = require('../dist/parsers/text');
const { OnlineBookSourceService, evaluateLegadoRule } = require('../dist/online');

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

  assert.deepEqual(getDisplayLines('这是一个很长的原文行\n下一行', 6), [
    { rawIndex: 0, text: '这是一个很长', segment: 0 },
    { rawIndex: 0, text: '的原文行', segment: 1 },
    { rawIndex: 1, text: '下一行', segment: 0 }
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

  const onlineSource = {
    bookSourceUrl: 'https://books.example.test',
    bookSourceName: '测试在线源',
    searchUrl: '/search?q={{java.encodeURI(key)}}',
    ruleSearch: {
      bookList: '@css:article.book',
      name: '@css:h2 @text',
      author: '@css:.author @text',
      bookUrl: '@css:a @href'
    },
    ruleBookInfo: {
      name: '@css:h1 @text',
      author: '@css:.author @text',
      tocUrl: '@css:a.catalog @href'
    },
    ruleToc: {
      chapterList: '@css:ul.chapters li',
      chapterName: '@css:a @text',
      chapterUrl: '@css:a @href##$##{"webView":true}'
    },
    ruleContent: {
      content: '@css:#content @html'
    }
  };
  const onlineService = new OnlineBookSourceService([onlineSource], async url => {
    const requestUrl = new URL(url);
    let body;
    if (requestUrl.pathname === '/search') {
      body = '<article class="book"><h2>测试在线书</h2><span class="author">测试作者</span><a href="/book/1">详情</a></article>';
    } else if (requestUrl.pathname === '/book/1') {
      body = '<h1>测试在线书</h1><span class="author">测试作者</span><a class="catalog" href="/book/1/catalog">目录</a>';
    } else if (requestUrl.pathname === '/book/1/catalog') {
      body = '<ul class="chapters"><li><a href="/chapter/1">第一章</a></li><li><a href="/chapter/2">第二章</a></li></ul>';
    } else if (requestUrl.pathname === '/chapter/1') {
      body = '<div id="content"><p>第一章正文</p></div>';
    } else if (requestUrl.pathname === '/chapter/2') {
      body = '<div id="content"><p>第二章正文</p></div>';
    } else {
      throw new Error(`unexpected URL: ${url}`);
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const onlineSearch = await onlineService.search('测试');
  assert.equal(onlineSearch.failures.length, 0);
  assert.equal(onlineSearch.results.length, 1);
  assert.equal(onlineSearch.results[0].title, '测试在线书');
  const onlineBook = await onlineService.openSearchResult(onlineSearch.results[0]);
  assert.equal(onlineBook.format, 'online');
  assert.equal(onlineBook.chapters.length, 2);
  assert.equal(onlineBook.chapters[0].contentLoaded, false);
  const chapterContent = await onlineService.loadChapterContent(onlineBook.online, onlineBook.online.chapters[0]);
  assert.match(chapterContent, /第一章正文/);

  const apiSource = {
    bookSourceUrl: 'https://api.example.test',
    bookSourceName: 'JSON 测试源',
    searchUrl: '/search,{"method":"POST","body":"q={{key}}&page={{page}}"}',
    ruleSearch: {
      bookList: '$.data.books[*]',
      name: '$.title',
      author: 'author',
      bookUrl: 'https://api.example.test/book/{{$.id}}'
    },
    ruleBookInfo: {
      init: '$.data',
      name: '$.title',
      author: '$.author',
      tocUrl: '$.toc'
    },
    ruleToc: {
      chapterList: '$.chapters[*]',
      chapterName: 'name',
      chapterUrl: 'url'
    },
    ruleContent: {
      content: '$.content'
    }
  };
  const apiService = new OnlineBookSourceService([apiSource], async (url, init) => {
    const requestUrl = new URL(url);
    if (requestUrl.pathname === '/search') {
      assert.equal(init.method, 'POST');
      assert.match(String(init.body), /q=API&page=1/);
      return new Response(JSON.stringify({ data: { books: [{ id: 7, title: 'API 书', author: 'API 作者' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.pathname === '/book/7') {
      return new Response(JSON.stringify({ data: { title: 'API 书', author: 'API 作者', toc: '/toc/7' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (requestUrl.pathname === '/toc/7') {
      return new Response(JSON.stringify({ chapters: [{ name: 'API 第一章', url: '/chapter/7/1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ content: 'API 正文' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  const apiSearch = await apiService.search('API');
  assert.equal(apiSearch.results[0].author, 'API 作者');
  const apiBook = await apiService.openSearchResult(apiSearch.results[0]);
  assert.equal(apiBook.chapters[0].title, 'API 第一章');
  assert.equal(await apiService.loadChapterContent(apiBook.online, apiBook.online.chapters[0]), 'API 正文');

  const legacySource = {
    bookSourceUrl: 'https://legacy.example.test',
    bookSourceName: '旧式选择器测试源',
    searchUrl: '/search?q={{key}}',
    ruleSearch: {
      bookList: 'class.bookbox',
      name: 'tag.h3.0@tag.a.0@text',
      author: 'class.author.0@text',
      bookUrl: 'tag.a.0@href'
    },
    ruleBookInfo: {
      name: 'tag.h1.0@text',
      tocUrl: 'id.catalog.0@href'
    },
    ruleToc: {
      chapterList: 'id.list.0@tag.a[-1:0]',
      chapterName: 'text',
      chapterUrl: 'href'
    },
    ruleContent: {
      content: 'class.con.0@html',
      replaceRegex: '##^{{book.durChapterTitle}}\\s*'
    }
  };
  const legacyService = new OnlineBookSourceService([legacySource], async url => {
    const requestUrl = new URL(url);
    if (requestUrl.pathname === '/search') {
      return new Response('<div class="bookbox"><h3><a href="/book/legacy">旧式在线书</a></h3><span class="author">旧式作者</span></div>', { status: 200 });
    }
    if (requestUrl.pathname === '/book/legacy') {
      return new Response('<h1>旧式在线书</h1><a id="catalog" href="/book/legacy/catalog">目录</a>', { status: 200 });
    }
    if (requestUrl.pathname === '/book/legacy/catalog') {
      return new Response('<div id="list"><a href="/chapter/one">第一章</a><a href="/chapter/two">第二章</a></div>', { status: 200 });
    }
    if (requestUrl.pathname === '/chapter/one') {
      return new Response('<div class="con"><p>第一章正文</p></div>', { status: 200 });
    }
    if (requestUrl.pathname === '/chapter/two') {
      return new Response('<div class="con"><p>第二章</p><p>第二章正文</p></div>', { status: 200 });
    }
    throw new Error(`unexpected legacy URL: ${url}`);
  });
  const legacySearch = await legacyService.search('旧式');
  assert.equal(legacySearch.failures.length, 0);
  assert.equal(legacySearch.results[0].author, '旧式作者');
  const legacyBook = await legacyService.openSearchResult(legacySearch.results[0]);
  assert.deepEqual(legacyBook.chapters.map(chapter => chapter.title), ['第二章', '第一章']);
  assert.equal(await legacyService.loadChapterContent(legacyBook.online, legacyBook.online.chapters[0]), '第二章正文');

  const jsonRuleValue = evaluateLegadoRule('$.data.books[*].name', {
    source: '',
    json: { data: { books: [{ name: '书一' }, { name: '书二' }] } }
  });
  assert.deepEqual(jsonRuleValue, ['书一', '书二']);

  const legacyJsonPathValue = evaluateLegadoRule('data[0]', {
    source: '',
    json: { data: [{ id: 42 }] }
  });
  assert.deepEqual(legacyJsonPathValue, { id: 42 });

  const putVariables = {};
  const putValue = evaluateLegadoRule('name@put:{bookId:id}', {
    source: '',
    variables: putVariables,
    json: { name: '带变量的书', id: 7 }
  });
  assert.equal(putValue, '带变量的书');
  assert.equal(putVariables.bookId, 7);
  assert.equal(evaluateLegadoRule('https://example.test/book/@get:{bookId}', {
    source: '',
    variables: putVariables
  }), 'https://example.test/book/7');

  await fs.rm(directory, { recursive: true, force: true });
  console.log('unit tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
