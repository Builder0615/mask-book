import { promises as fs } from 'node:fs';
import * as iconv from 'iconv-lite';
import { JSONPath } from 'jsonpath-plus';
import * as cheerio from 'cheerio';
import { DOMParser, Document } from '@xmldom/xmldom';
import * as xpath from 'xpath';
import { extractMarkupText, normalizeMarkupText, parseMarkup } from './parsers/markup';
import { normalizePlainText } from './parsers/text';
import {
  Book,
  Chapter,
  OnlineBookReference,
  OnlineChapterReference
} from './types';

const MAX_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_TOC_PAGES = 100;
const MAX_CONTENT_PAGES = 20;

export interface LegadoRuleMap {
  [key: string]: unknown;
}

export interface LegadoBookSource {
  bookSourceUrl: string;
  bookSourceName?: string;
  bookSourceGroup?: string;
  bookSourceType?: number;
  enabled?: boolean;
  searchUrl?: string;
  header?: string | Record<string, unknown>;
  weight?: number;
  customOrder?: number;
  ruleSearch?: LegadoRuleMap;
  ruleBookInfo?: LegadoRuleMap;
  ruleToc?: LegadoRuleMap;
  ruleContent?: LegadoRuleMap;
  [key: string]: unknown;
}

export interface OnlineSearchResult {
  id: string;
  title: string;
  author?: string;
  kind?: string;
  wordCount?: string;
  lastChapter?: string;
  intro?: string;
  coverUrl?: string;
  bookUrl: string;
  sourceUrl: string;
  sourceName: string;
  sourceWeight: number;
  query: string;
  page: number;
  variables?: Record<string, unknown>;
}

export interface SearchBatch {
  results: OnlineSearchResult[];
  failures: Array<{ sourceName: string; message: string }>;
}

export type OnlineFetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface RequestSpec {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  charset?: string;
}

interface RulePage {
  url: string;
  text: string;
  context: RuleContext;
}

interface RuleContext {
  source: string;
  variables: Record<string, unknown>;
  json?: unknown;
  dom?: Document;
  $?: ReturnType<typeof cheerio.load>;
  node?: any;
  xmlNode?: any;
}

interface ParsedCleanRule {
  base: string;
  pattern: string;
  replacement: string;
}

/**
 * A small, declarative Legado-compatible source runner.
 *
 * It intentionally does not execute arbitrary source JavaScript. This keeps
 * imported third-party source files from gaining access to the extension's
 * Node.js process while still supporting the selectors used by most sources.
 */
export class OnlineBookSourceService {
  private sources: LegadoBookSource[];
  private timeoutMs: number;
  private readonly fetcher: OnlineFetcher;

  public constructor(
    sources: LegadoBookSource[] = [],
    fetcher: OnlineFetcher = (input, init) => globalThis.fetch(input, init)
  ) {
    this.sources = normalizeBookSources(sources);
    this.timeoutMs = 15_000;
    this.fetcher = fetcher;
  }

  public setSources(sources: LegadoBookSource[]): void {
    this.sources = normalizeBookSources(sources);
  }

  public getSources(): LegadoBookSource[] {
    return [...this.sources];
  }

  public setTimeoutMs(timeoutMs: number): void {
    this.timeoutMs = Math.max(3_000, Math.min(60_000, timeoutMs));
  }

  public getSearchableSources(): LegadoBookSource[] {
    return this.sources
      .filter(source => source.enabled !== false)
      .filter(source => Number(source.bookSourceType) !== 1)
      .filter(source => {
        const searchUrl = String(source.searchUrl || source.ruleSearch?.url || '').trim();
        const bookList = String(source.ruleSearch?.bookList || '').trim();
        return Boolean(searchUrl)
          && !isUnsupportedScriptRule(searchUrl)
          && !isUnsupportedScriptRule(bookList);
      })
      .sort((left, right) => {
        const orderDifference = numberValue(left.customOrder) - numberValue(right.customOrder);
        if (orderDifference !== 0) {
          return orderDifference;
        }
        return numberValue(right.weight) - numberValue(left.weight);
      });
  }

  public async readSourceInput(input: string): Promise<LegadoBookSource[]> {
    const value = input.trim();
    if (!value) {
      throw new Error('没有提供书源内容。');
    }

    if (/^https?:\/\//i.test(value)) {
      const page = await this.requestPage(value, undefined, {});
      return parseBookSources(page.text);
    }

    try {
      const stats = await fs.stat(value);
      if (stats.isFile()) {
        return parseBookSources(await fs.readFile(value, 'utf8'));
      }
    } catch {
      // If it is not a readable path, it may be pasted JSON.
    }

    return parseBookSources(value);
  }

  public async search(
    key: string,
    sources: LegadoBookSource[] = this.getSearchableSources(),
    page = 1
  ): Promise<SearchBatch> {
    const results: OnlineSearchResult[] = [];
    const failures: Array<{ sourceName: string; message: string }> = [];
    const selectedSources = [...new Map(sources.map(source => [source.bookSourceUrl, source])).values()];

    await runWithConcurrency(selectedSources, 4, async source => {
      try {
        results.push(...await this.searchSource(source, key, page));
      } catch (error) {
        failures.push({
          sourceName: source.bookSourceName || source.bookSourceUrl,
          message: errorMessage(error)
        });
      }
    });

    const uniqueResults = new Map<string, OnlineSearchResult>();
    for (const result of results) {
      const identity = `${result.sourceUrl}\n${result.bookUrl}\n${result.title}`;
      if (!uniqueResults.has(identity)) {
        uniqueResults.set(identity, result);
      }
    }

    return {
      results: [...uniqueResults.values()].sort((left, right) => {
        const weightDifference = right.sourceWeight - left.sourceWeight;
        return weightDifference !== 0 ? weightDifference : left.title.localeCompare(right.title, 'zh-CN');
      }),
      failures
    };
  }

  public async openSearchResult(result: OnlineSearchResult): Promise<Book> {
    const source = this.getSource(result.sourceUrl);
    const bookUrl = stripUrlOptions(resolveUrl(source.bookSourceUrl, result.bookUrl));
    const bookVariables: Record<string, unknown> = {
      key: result.query,
      page: result.page,
      ...result.variables,
      book: {
        ...result.variables,
        bookUrl,
        origin: source.bookSourceUrl,
        sourceUrl: source.bookSourceUrl,
        name: result.title,
        author: result.author,
        kind: result.kind,
        intro: result.intro,
        coverUrl: result.coverUrl,
        lastChapter: result.lastChapter,
        wordCount: result.wordCount
      }
    };

    const infoPage = await this.requestPage(bookUrl, source, bookVariables);
    const infoContext = applyRuleInit(source.ruleBookInfo?.init, infoPage.context);
    const info = extractBookInfo(source.ruleBookInfo, infoContext);
    const enrichedBook: Record<string, unknown> = {
      ...bookVariables.book as Record<string, unknown>,
      ...info,
      bookUrl,
      origin: source.bookSourceUrl,
      sourceUrl: source.bookSourceUrl
    };
    bookVariables.book = enrichedBook;
    infoPage.context.variables.book = enrichedBook;
    infoContext.variables.book = enrichedBook;

    const tocUrl = stripUrlOptions(resolveUrl(
      bookUrl,
      stringValue(info.tocUrl) || bookUrl
    ));
    const tocPage = sameUrl(bookUrl, tocUrl)
      ? { ...infoPage, url: tocUrl }
      : await this.requestPage(tocUrl, source, bookVariables);
    const chapterReferences = await this.readToc(source, tocUrl, tocPage, bookVariables);
    if (chapterReferences.length === 0) {
      throw new Error(`《${stringValue(enrichedBook.name) || result.title}》没有解析到章节目录。`);
    }

    const title = stringValue(enrichedBook.name) || result.title || '未命名在线书籍';
    const reference: OnlineBookReference = {
      id: onlineBookId(source.bookSourceUrl, bookUrl),
      sourceUrl: source.bookSourceUrl,
      sourceName: source.bookSourceName || source.bookSourceUrl,
      bookUrl,
      tocUrl,
      title,
      author: stringValue(enrichedBook.author) || undefined,
      intro: stringValue(enrichedBook.intro) || undefined,
      chapters: chapterReferences,
      variables: {
        ...(result.variables || {}),
        ...enrichedBook
      }
    };

    return bookFromReference(reference);
  }

  public bookFromReference(reference: OnlineBookReference): Book {
    this.getSource(reference.sourceUrl);
    return bookFromReference(reference);
  }

  public async loadChapterContent(reference: OnlineBookReference, chapter: OnlineChapterReference): Promise<string> {
    const source = this.getSource(reference.sourceUrl);
    const variables: Record<string, unknown> = {
      ...reference.variables,
      book: {
        ...reference.variables,
        bookUrl: reference.bookUrl,
        origin: source.bookSourceUrl,
        sourceUrl: source.bookSourceUrl,
        name: reference.title,
        author: reference.author,
        intro: reference.intro,
        durChapterTitle: chapter.title,
        durChapterIndex: reference.chapters.findIndex(item => item.id === chapter.id)
      },
      chapter: {
        title: chapter.title,
        url: chapter.url,
        index: reference.chapters.findIndex(item => item.id === chapter.id)
      }
    };
    let pageUrl = stripUrlOptions(resolveUrl(reference.bookUrl, chapter.url));
    const visited = new Set<string>();
    const parts: string[] = [];

    for (let index = 0; index < MAX_CONTENT_PAGES && pageUrl; index += 1) {
      if (visited.has(pageUrl)) {
        break;
      }
      visited.add(pageUrl);
      const page = await this.requestPage(pageUrl, source, variables);
      const rule = source.ruleContent || {};
      const value = rule.content
        ? evaluateLegadoRule(String(rule.content), page.context)
        : fallbackPageText(page.text);
      const content = contentValueToText(value, page.context);
      if (content) {
        parts.push(content);
      }

      const next = rule.nextContentUrl
        ? firstUrl(evaluateLegadoRule(String(rule.nextContentUrl), page.context))
        : '';
      if (!next) {
        break;
      }
      pageUrl = stripUrlOptions(resolveUrl(pageUrl, next));
    }

    let content = normalizePlainText(parts.filter(Boolean).join('\n\n'));
    const replaceRegex = source.ruleContent?.replaceRegex;
    if (typeof replaceRegex === 'string' && replaceRegex.trim()) {
      content = applyReplaceRegex(content, interpolateString(replaceRegex, variables));
    }
    return content || '（本章没有可显示的正文内容）';
  }

  private async searchSource(source: LegadoBookSource, key: string, page: number): Promise<OnlineSearchResult[]> {
    const rule = source.ruleSearch || {};
    const searchUrl = String(source.searchUrl || rule.url || '').trim();
    if (!searchUrl) {
      return [];
    }
    const variables = { key, page };
    const request = makeRequestSpec(searchUrl, source, variables);
    const searchPage = await this.requestPage(request.url, source, variables, request);
    const listRule = typeof rule.bookList === 'string' ? rule.bookList : '';
    const reverse = listRule.trim().startsWith('-');
    const rows = listRule
      ? ruleList(evaluateLegadoRule(reverse ? listRule.trim().slice(1).trim() : listRule, searchPage.context))
      : [];
    if (reverse) {
      rows.reverse();
    }
    const results: OnlineSearchResult[] = [];

    for (const row of rows) {
      const context = contextForItem(searchPage.context, row);
      const bookUrl = stringValue(ruleValue(rule.bookUrl, context));
      if (!bookUrl) {
        continue;
      }
      const title = stringValue(ruleValue(rule.name, context)) || '未命名书籍';
      const normalizedBookUrl = stripUrlOptions(resolveUrl(searchPage.url, bookUrl));
      const rowVariables = isRecord(row) && !isCheerioNode(row) && !isXmlNode(row)
        ? { ...context.variables, ...row }
        : { ...context.variables };
      results.push({
        id: `${source.bookSourceUrl}\n${normalizedBookUrl}\n${title}`,
        title,
        author: optionalRuleValue(rule.author, context),
        kind: optionalRuleValue(rule.kind, context),
        wordCount: optionalRuleValue(rule.wordCount, context),
        lastChapter: optionalRuleValue(rule.lastChapter, context),
        intro: optionalRuleValue(rule.intro, context),
        coverUrl: resolveOptionalUrl(searchPage.url, optionalRuleValue(rule.coverUrl, context)),
        bookUrl: normalizedBookUrl,
        sourceUrl: source.bookSourceUrl,
        sourceName: source.bookSourceName || source.bookSourceUrl,
        sourceWeight: numberValue(source.weight),
        query: key,
        page,
        variables: Object.keys(rowVariables).length > 0 ? rowVariables : undefined
      });
    }
    return results;
  }

  private async readToc(
    source: LegadoBookSource,
    initialUrl: string,
    initialPage: RulePage,
    variables: Record<string, unknown>
  ): Promise<OnlineChapterReference[]> {
    const rule = source.ruleToc || {};
    const chapters: OnlineChapterReference[] = [];
    const visitedPages = new Set<string>();
    let page = initialPage;
    let pageUrl = initialUrl;

    for (let pageIndex = 0; pageIndex < MAX_TOC_PAGES && pageUrl; pageIndex += 1) {
      if (visitedPages.has(pageUrl)) {
        break;
      }
      visitedPages.add(pageUrl);
      page.context.variables = variables;
      const listRule = String(rule.chapterList || '');
      const reverse = listRule.trim().startsWith('-');
      const listValue = evaluateLegadoRule(reverse ? listRule.trim().slice(1).trim() : listRule, page.context);
      const rows = ruleList(listValue);
      const pageChapters: OnlineChapterReference[] = [];

      for (const row of rows) {
        const context = contextForItem(page.context, row);
        const title = stringValue(ruleValue(rule.chapterName, context));
        const rawUrl = stringValue(ruleValue(rule.chapterUrl, context));
        if (!title || !rawUrl) {
          continue;
        }
        const url = stripUrlOptions(resolveUrl(pageUrl, rawUrl));
        if (!url) {
          continue;
        }
        pageChapters.push({
          id: `chapter-${chapters.length + pageChapters.length + 1}`,
          title,
          url,
          source: pageUrl
        });
      }

      if (reverse) {
        pageChapters.reverse();
      }
      for (const chapter of pageChapters) {
        if (!chapters.some(item => item.url === chapter.url && item.title === chapter.title)) {
          chapter.id = `chapter-${chapters.length + 1}`;
          chapters.push(chapter);
        }
      }

      const next = rule.nextTocUrl
        ? firstUrl(evaluateLegadoRule(String(rule.nextTocUrl), page.context))
        : '';
      if (!next) {
        break;
      }
      pageUrl = stripUrlOptions(resolveUrl(pageUrl, next));
      page = await this.requestPage(pageUrl, source, variables);
    }

    return chapters;
  }

  private getSource(sourceUrl: string): LegadoBookSource {
    const source = this.sources.find(item => item.bookSourceUrl === sourceUrl);
    if (!source) {
      throw new Error(`找不到书源：${sourceUrl}`);
    }
    return source;
  }

  private async requestPage(
    url: string,
    source: LegadoBookSource | undefined,
    variables: Record<string, unknown>,
    request?: RequestSpec
  ): Promise<RulePage> {
    const spec = request || makeRequestSpec(url, source, variables);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(spec.url, {
        method: spec.method,
        headers: spec.headers,
        body: spec.method === 'GET' || spec.method === 'HEAD' ? undefined : spec.body,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_SOURCE_BYTES) {
        throw new Error(`响应超过 ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)} MB 限制。`);
      }
      const contentType = response.headers.get('content-type') || '';
      const charset = spec.charset || contentType.match(/charset\s*=\s*([^;]+)/i)?.[1];
      const text = decodeResponse(buffer, charset);
      return {
        url: spec.url,
        text,
        context: createRuleContext(text, variables)
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`请求超时（${this.timeoutMs} ms）：${spec.url}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseBookSources(value: string | unknown): LegadoBookSource[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value.replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('书源不是有效的 JSON。请粘贴 JSON 数组、单个书源对象，或 JSON 文件/URL。');
    }
  }

  const root = parsed as { sources?: unknown } | null;
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root?.sources)
      ? root.sources
      : parsed && typeof parsed === 'object'
        ? [parsed]
        : [];
  const sources = candidates
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(item => normalizeSource(item))
    .filter((source): source is LegadoBookSource => Boolean(source));
  if (sources.length === 0) {
    throw new Error('没有找到包含 bookSourceUrl 的 Legado 书源。');
  }
  return sources;
}

export function normalizeBookSources(sources: LegadoBookSource[]): LegadoBookSource[] {
  const normalized = sources
    .map(source => normalizeSource(source))
    .filter((source): source is LegadoBookSource => Boolean(source));
  return [...new Map(normalized.map(source => [source.bookSourceUrl, source])).values()];
}

export function evaluateLegadoRule(rule: string, context: RuleContextForTest): unknown {
  return evaluateRule(rule, {
    source: context.source,
    variables: context.variables || {},
    json: context.json,
    $: context.$,
    dom: context.dom,
    node: context.node,
    xmlNode: context.xmlNode
  });
}

export interface RuleContextForTest {
  source: string;
  variables?: Record<string, unknown>;
  json?: unknown;
  $?: ReturnType<typeof cheerio.load>;
  dom?: Document;
  node?: any;
  xmlNode?: any;
}

function normalizeSource(value: Record<string, unknown>): LegadoBookSource | undefined {
  const sourceUrl = stringValue(value.bookSourceUrl || value.sourceUrl);
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    return undefined;
  }
  const source: LegadoBookSource = {
    bookSourceUrl: sourceUrl,
    bookSourceName: stringValue(value.bookSourceName || value.sourceName) || sourceUrl,
    enabled: value.enabled !== false && value.enabled !== 'false' && value.enabled !== 0 && value.enabled !== '0',
    ruleSearch: isRecord(value.ruleSearch) ? value.ruleSearch : undefined,
    ruleBookInfo: isRecord(value.ruleBookInfo) ? value.ruleBookInfo : undefined,
    ruleToc: isRecord(value.ruleToc) ? value.ruleToc : undefined,
    ruleContent: isRecord(value.ruleContent) ? value.ruleContent : undefined
  };
  if (typeof value.bookSourceGroup === 'string') {
    source.bookSourceGroup = value.bookSourceGroup;
  }
  if (typeof value.bookSourceType === 'number' || typeof value.bookSourceType === 'string') {
    const bookSourceType = Number(value.bookSourceType);
    if (Number.isFinite(bookSourceType)) {
      source.bookSourceType = bookSourceType;
    }
  }
  if (typeof value.searchUrl === 'string') {
    source.searchUrl = value.searchUrl;
  }
  if (typeof value.header === 'string' || isRecord(value.header)) {
    source.header = value.header;
  }
  const weight = optionalNumber(value.weight);
  if (weight !== undefined) {
    source.weight = weight;
  }
  const customOrder = optionalNumber(value.customOrder);
  if (customOrder !== undefined) {
    source.customOrder = customOrder;
  }
  return source;
}

function createRuleContext(source: string, variables: Record<string, unknown>): RuleContext {
  const json = parseJson(source);
  if (json !== undefined) {
    return { source, variables, json };
  }
  let dom: Document | undefined;
  try {
    const xpathSource = source
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!doctype[\s\S]*?>/gi, '')
      .replace(/&nbsp;/gi, '&#160;');
    dom = new DOMParser({ onError: () => undefined }).parseFromString(`<root>${xpathSource}</root>`, 'application/xml');
  } catch {
    // CSS parsing may still work for malformed fragments.
  }
  return {
    source,
    variables,
    dom,
    $: cheerio.load(source)
  };
}

function contextForItem(parent: RuleContext, item: unknown): RuleContext {
  if (isCheerioSelection(item)) {
    return {
      ...parent,
      node: item,
      xmlNode: undefined
    };
  }
  if (isCheerioNode(item)) {
    return {
      ...parent,
      node: item,
      xmlNode: undefined
    };
  }
  if (isXmlNode(item)) {
    return {
      ...parent,
      node: undefined,
      xmlNode: item
    };
  }
  return {
    ...parent,
    json: item,
    node: undefined,
    xmlNode: undefined
  };
}

function applyRuleInit(rule: unknown, context: RuleContext): RuleContext {
  if (typeof rule !== 'string' || !rule.trim()) {
    return context;
  }
  const initialized = evaluateLegadoRule(rule, {
    source: context.source,
    variables: context.variables,
    json: context.json,
    $: context.$,
    dom: context.dom,
    node: context.node,
    xmlNode: context.xmlNode
  });
  return hasValue(initialized) ? contextForItem(context, initialized) : context;
}

function ruleList(value: unknown): unknown[] {
  if (isCheerioSelection(value)) {
    return value.toArray();
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return [];
  }
  if (isXmlNode(value)) {
    return [value];
  }
  return [value];
}

function ruleValue(rule: unknown, context: RuleContext): unknown {
  if (typeof rule !== 'string' || !rule.trim()) {
    return '';
  }
  return evaluateRule(rule, context);
}

function optionalRuleValue(rule: unknown, context: RuleContext): string | undefined {
  const value = stringValue(ruleValue(rule, context));
  return value || undefined;
}

function evaluateRule(rule: string, context: RuleContext): unknown {
  const value = rule.trim();
  if (!value) {
    return '';
  }

  const declarativeRule = removeUnsupportedScriptSections(value);
  if (declarativeRule !== value) {
    return declarativeRule ? evaluateRule(declarativeRule, context) : '';
  }

  const clean = splitCleanRule(value);
  if (clean) {
    const base = stringValue(evaluateRule(clean.base, context));
    if (clean.pattern.trim() === '$' && looksLikeUrlOptions(clean.replacement)) {
      return `${base}${clean.replacement.trimStart().startsWith(',') ? '' : ','}${clean.replacement.trimStart()}`;
    }
    return applyCleaning(base, clean.pattern, clean.replacement);
  }

  const put = splitPutRule(value);
  if (put) {
    const result = evaluateRule(put.base, context);
    applyPutAssignments(put.assignments, context);
    return result;
  }

  const alternatives = splitOperator(value, '||');
  if (alternatives.length > 1) {
    for (const alternative of alternatives) {
      const result = evaluateRule(alternative, context);
      if (hasValue(result)) {
        return result;
      }
    }
    return '';
  }

  const concatenated = splitOperator(value, '&&');
  if (concatenated.length > 1) {
    return concatenated.map(item => stringValue(evaluateRule(item, context))).join('');
  }

  if (value.includes('{{') || /@get:\{/i.test(value)) {
    return interpolateRule(value, context);
  }

  return evaluateAtomicRule(value, context);
}

function removeUnsupportedScriptSections(value: string): string {
  let result = value;
  const withoutBlocks = result.replace(/<js>[\s\S]*?<\/js>/gi, '').trim();
  if (withoutBlocks !== result) {
    result = withoutBlocks;
  }
  const scriptSuffix = result.search(/@js:/i);
  if (scriptSuffix > 0) {
    result = result.slice(0, scriptSuffix).trim();
  }
  result = result.replace(/^\+\s*(?=(?:@css:|@xpath:|@json:|\$|\/|class\.|id\.|tag\.|[.#\[]|text\.))/i, '');
  return result;
}

function isUnsupportedScriptRule(value: string): boolean {
  const rule = value.trim();
  if (!rule) {
    return false;
  }
  return /(?:<js>|<\/js>|@js:)/i.test(rule) || /^(?:js:)/i.test(rule);
}

interface ParsedPutRule {
  base: string;
  assignments: string;
}

function splitPutRule(value: string): ParsedPutRule | undefined {
  const match = value.match(/^(.*)@put:\{([\s\S]*)\}\s*$/i);
  if (!match || !match[1].trim()) {
    return undefined;
  }
  return {
    base: match[1].trim(),
    assignments: match[2]
  };
}

function applyPutAssignments(value: string, context: RuleContext): void {
  for (const assignment of splitTopLevel(value, ',')) {
    const separator = topLevelDelimiter(assignment, ':');
    if (separator < 0) {
      continue;
    }
    const key = assignment.slice(0, separator).trim();
    if (!key) {
      continue;
    }
    const expression = assignment.slice(separator + 1).trim();
    context.variables[key] = expression ? evaluateRule(expression, context) : '';
  }
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') {
      braces += 1;
      continue;
    }
    if (character === '}') {
      braces = Math.max(0, braces - 1);
      continue;
    }
    if (character === '[') {
      brackets += 1;
      continue;
    }
    if (character === ']') {
      brackets = Math.max(0, brackets - 1);
      continue;
    }
    if (braces === 0 && brackets === 0 && value.startsWith(delimiter, index)) {
      parts.push(value.slice(start, index).trim());
      start = index + delimiter.length;
      index += delimiter.length - 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function topLevelDelimiter(value: string, delimiter: string): number {
  let braces = 0;
  let brackets = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') {
      braces += 1;
      continue;
    }
    if (character === '}') {
      braces = Math.max(0, braces - 1);
      continue;
    }
    if (character === '[') {
      brackets += 1;
      continue;
    }
    if (character === ']') {
      brackets = Math.max(0, brackets - 1);
      continue;
    }
    if (braces === 0 && brackets === 0 && value.startsWith(delimiter, index)) {
      return index;
    }
  }
  return -1;
}

function getRuleValue(expression: string, context: RuleContext): unknown {
  const value = expression.trim();
  const fromVariables = resolveVariable(value, context.variables, context.json);
  if (hasValue(fromVariables)) {
    return fromVariables;
  }
  return readRelativeNodeValue(value, context);
}

function evaluateAtomicRule(rule: string, context: RuleContext): unknown {
  if (/^@css:/i.test(rule)) {
    return evaluateCss(rule.slice(rule.indexOf(':') + 1), context);
  }
  if (/^@xpath:/i.test(rule)) {
    return evaluateXPath(rule.slice(rule.indexOf(':') + 1), context);
  }
  if (rule.startsWith('/') || rule.startsWith('./') || rule.startsWith('..')) {
    return evaluateXPath(rule, context);
  }
  if (/^@json:/i.test(rule)) {
    return evaluateJsonPath(rule.slice(rule.indexOf(':') + 1), context);
  }
  if (rule.startsWith('$')) {
    return evaluateJsonPath(rule, context);
  }
  if (/^@text:/i.test(rule)) {
    return rule.slice(rule.indexOf(':') + 1);
  }
  if (/^@regex:/i.test(rule)) {
    return regexValue(context.source, rule.slice(rule.indexOf(':') + 1));
  }
  const getMatch = rule.match(/^@get:\{([\s\S]*)\}$/i);
  if (getMatch) {
    return getRuleValue(getMatch[1], context);
  }
  if (/^@js:/i.test(rule)) {
    return evaluateSafeExpression(rule.slice(rule.indexOf(':') + 1), context);
  }
  if (looksLikeLegacyRule(rule)) {
    return evaluateLegacyRule(rule, context);
  }
  if (isVariableRule(rule)) {
    return resolveVariable(rule, context.variables, context.json);
  }
  if (context.node || context.xmlNode) {
    return readRelativeNodeValue(rule, context);
  }
  return resolveVariable(rule, context.variables, context.json);
}

/**
 * Legado also has a compact selector syntax predating the explicit @css/
 * @xpath prefixes. Examples include class.bookbox, tag.a.0@href and
 * id.catalog@tag.ul@tag.a[-1:0]. It is still common in public source files.
 */
function evaluateLegacyRule(rule: string, context: RuleContext): unknown {
  if (!context.$) {
    return '';
  }

  const segments = splitLegacySegments(rule);
  if (segments.length === 0) {
    return '';
  }

  let selection: any = context.node ? context.$(context.node) : context.$.root();
  let hasSelector = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (!segment) {
      continue;
    }

    const textFilter = parseLegacyTextFilter(segment);
    if (textFilter) {
      const candidates = hasSelector
        ? selection
        : context.$('*');
      const filtered = candidates.toArray().filter((node: any) => {
        const current = context.$?.(node);
        const text = current?.text() || '';
        if (!text.includes(textFilter.value)) {
          return false;
        }
        return !(current?.find('*').toArray() || []).some((child: any) => {
          return (context.$?.(child).text() || '').includes(textFilter.value);
        });
      });
      selection = context.$(applyLegacySelectionOperation(filtered, textFilter.operation));
      hasSelector = true;
      continue;
    }

    const accessor = parseLegacyAccessor(segment);
    if (last && accessor && hasSelector) {
      return readCssSelection(selection, accessor, context);
    }

    const selector = parseLegacySelector(segment);
    if (!selector) {
      if (last && hasSelector) {
        return readCssSelection(selection, segment, context);
      }
      return '';
    }

    if (selector.children) {
      const children = selection.toArray().flatMap((node: any) => context.$?.(node).children().toArray() || []);
      selection = context.$(applyLegacySelectionOperation(children, selector.operation));
    } else {
      const selected = selection.find(selector.cssSelector);
      const self = index === 0 && context.node
        ? selection.filter(selector.cssSelector).toArray()
        : [];
      selection = context.$(applyLegacySelectionOperation([...self, ...selected.toArray()], selector.operation));
    }
    hasSelector = true;
  }

  return selection;
}

interface LegacySelectionOperation {
  index?: number;
  omit?: number;
  range?: [number, number];
}

interface ParsedLegacySelector {
  cssSelector?: string;
  children?: boolean;
  operation: LegacySelectionOperation;
}

interface ParsedLegacyTextFilter {
  value: string;
  operation: LegacySelectionOperation;
}

function splitLegacySegments(value: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (character === '@' && bracketDepth === 0) {
      const segment = value.slice(start, index).trim();
      if (segment) {
        segments.push(segment);
      }
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) {
    segments.push(last);
  }
  return segments;
}

function parseLegacyTextFilter(segment: string): ParsedLegacyTextFilter | undefined {
  const match = segment.match(/^text(?:\.(.*))?$/s);
  if (!match || !match[1]) {
    return undefined;
  }
  return {
    value: match[1],
    operation: parseLegacySelectionOperation(match[1])
  };
}

function parseLegacyAccessor(segment: string): string | undefined {
  const accessor = segment.replace(/^@/, '').trim();
  if (/^(?:class|id|tag)\./i.test(accessor) || /^children(?:\[|$)/i.test(accessor) || isKnownLegacyTagSelector(accessor)) {
    return undefined;
  }
  if (/^(?:text|html|textNodes|ownText|href|src|content)$/i.test(accessor)) {
    return accessor;
  }
  if (/^[a-zA-Z_:][\w:.-]*$/.test(accessor) && !/^(?:class|id|tag|children)$/i.test(accessor)) {
    return accessor;
  }
  return undefined;
}

function parseLegacySelector(segment: string): ParsedLegacySelector | undefined {
  const trimmed = segment.trim();
  if (!trimmed) {
    return undefined;
  }
  const operation = parseLegacySelectionOperation(trimmed);
  const selectorText = removeLegacySelectionOperation(trimmed);
  if (/^children(?:\[.*\])?$/i.test(selectorText)) {
    return { children: true, operation };
  }

  let cssSelector = selectorText;
  const classMatch = selectorText.match(/^class\.(.+)$/i);
  if (classMatch) {
    const classNames = classMatch[1].split(/\s+/).filter(Boolean);
    cssSelector = classNames.map(name => name.startsWith('.') ? name : `.${name}`).join('');
  } else {
    const idMatch = selectorText.match(/^id\.(.+)$/i);
    if (idMatch) {
      cssSelector = `#${idMatch[1]}`;
    } else {
      const tagMatch = selectorText.match(/^tag\.(.+)$/i);
      if (tagMatch) {
        cssSelector = tagMatch[1];
      }
    }
  }

  if (!isLikelyCssSelector(cssSelector)) {
    return undefined;
  }
  return { cssSelector, operation };
}

function parseLegacySelectionOperation(value: string): LegacySelectionOperation {
  const operation: LegacySelectionOperation = {};
  const bracketIndex = value.match(/\[(-?\d+)\]\s*$/);
  if (bracketIndex) {
    operation.index = Number(bracketIndex[1]);
  }
  const range = value.match(/\[(-?\d+)\s*:\s*(-?\d+)\]\s*$/);
  if (range) {
    operation.range = [Number(range[1]), Number(range[2])];
  }
  const omit = value.match(/!(-?\d+)\s*$/);
  if (omit) {
    operation.omit = Number(omit[1]);
  }
  const index = value.match(/(?:^|\.)(-?\d+)\s*$/);
  if (index) {
    operation.index = Number(index[1]);
  }
  return operation;
}

function removeLegacySelectionOperation(value: string): string {
  return value
    .replace(/\[(-?\d+)\s*:\s*(-?\d+)\]\s*$/, '')
    .replace(/\[(-?\d+)\]\s*$/, '')
    .replace(/!(-?\d+)\s*$/, '')
    .replace(/(?:^|\.)(-?\d+)\s*$/, match => match.startsWith('.') ? '' : match);
}

function applyLegacySelectionOperation(nodes: any[], operation: LegacySelectionOperation): any[] {
  let result = [...nodes];
  if (operation.omit !== undefined) {
    const omitIndex = normalizeLegacyIndex(operation.omit, result.length);
    if (omitIndex >= 0) {
      result = result.filter((_node, index) => index !== omitIndex);
    }
  }
  if (operation.range) {
    const [start, end] = operation.range;
    if (start === -1 && end === 0) {
      result.reverse();
    } else {
      const normalizedStart = normalizeLegacySliceIndex(start, result.length);
      const normalizedEnd = normalizeLegacySliceIndex(end, result.length);
      result = normalizedStart <= normalizedEnd
        ? result.slice(normalizedStart, normalizedEnd)
        : result.slice(normalizedEnd, normalizedStart).reverse();
    }
  }
  if (operation.index !== undefined) {
    const selectedIndex = normalizeLegacyIndex(operation.index, result.length);
    result = selectedIndex >= 0 && selectedIndex < result.length ? [result[selectedIndex]] : [];
  }
  return result;
}

function normalizeLegacyIndex(index: number, length: number): number {
  return index < 0 ? length + index : index;
}

function normalizeLegacySliceIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length, index < 0 ? length + index : index));
}

function isLikelyCssSelector(value: string): boolean {
  return value === '*'
    || /^[.#\[]/.test(value)
    || /^[a-zA-Z][\w-]*(?:[.#:[>+~\s]|$)/.test(value);
}

function isKnownLegacyTagSelector(value: string): boolean {
  return /^(?:a|abbr|article|aside|body|button|dd|div|dl|dt|em|h[1-6]|head|html|img|label|li|main|meta|nav|ol|p|section|small|span|strong|table|tbody|td|textarea|tfoot|th|thead|tr|ul)(?:[.#:[>+~\s]|$)/i.test(value);
}

function looksLikeLegacyRule(value: string): boolean {
  const rule = value.trim();
  if (!rule) {
    return false;
  }
  return /^(?:class|id|tag)\./i.test(rule)
    || /^text\./i.test(rule)
    || /^children(?:\[|@|$)/i.test(rule)
    || /^[.#\[]/.test(rule)
    || (rule.includes('@') && isLikelyCssSelector(splitLegacySegments(rule)[0] || ''))
    || isKnownLegacyTagSelector(rule);
}

function evaluateCss(rule: string, context: RuleContext): unknown {
  if (!context.$) {
    return '';
  }
  const parsed = parseCssRule(rule);
  try {
    const selection = context.node
      ? context.$(context.node).find(parsed.selector)
      : context.$(parsed.selector);
    if (!parsed.accessor) {
      return selection;
    }
    return readCssSelection(selection, parsed.accessor, context);
  } catch {
    return '';
  }
}

function evaluateXPath(expression: string, context: RuleContext): unknown {
  const root = context.xmlNode || context.dom;
  if (!root) {
    return '';
  }
  try {
    return xpath.select(expression.trim(), root);
  } catch {
    return '';
  }
}

function evaluateJsonPath(expression: string, context: RuleContext): unknown {
  const json = context.json;
  if (json === undefined) {
    return resolveVariable(expression, context.variables, undefined);
  }
  try {
    const result = JSONPath({ path: expression.trim(), json, wrap: true, eval: false }) as unknown[];
    if (result.length === 0) {
      return '';
    }
    return result.length === 1 ? result[0] : result;
  } catch {
    return '';
  }
}

function evaluateSafeExpression(expression: string, context: RuleContext): unknown {
  const value = expression.trim().replace(/^\((.*)\)$/s, '$1').trim();
  const functionMatch = value.match(/^(?:java\.)?(encodeURI|encodeURIComponent)\((.*)\)$/s);
  if (functionMatch) {
    const argumentsList = splitFunctionArguments(functionMatch[2]);
    const argument = stringValue(evaluateExpressionValue(argumentsList[0] || '', context));
    return encodeArgument(argument, functionMatch[1], stringLiteral(argumentsList[1]));
  }
  const stringMatch = value.match(/^String\((.*)\)$/s);
  if (stringMatch) {
    return stringValue(evaluateExpressionValue(stringMatch[1], context));
  }
  return evaluateExpressionValue(value, context);
}

function evaluateExpressionValue(expression: string, context: RuleContext): unknown {
  const value = expression.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value === 'result') {
    return context.variables.result ?? context.json;
  }
  return resolveVariable(value, context.variables, context.json);
}

function interpolateRule(rule: string, context: RuleContext): string {
  return rule
    .replace(/\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => {
      return stringValue(evaluateRule(expression, context));
    })
    .replace(/@get:\{([^{}]+)\}/gi, (_match, expression: string) => {
      return stringValue(getRuleValue(expression, context));
    });
}

function readCssSelection(selection: any, accessor: string, context: RuleContext): unknown {
  const nodes = selection.toArray();
  if (accessor === 'html') {
    return nodes.length > 0 ? context.$?.html(nodes[0]) || '' : '';
  }
  if (accessor === 'textNodes' || accessor === 'ownText') {
    return nodes.map((node: any) => accessor === 'ownText'
      ? ownText(node)
      : markupText(context.$?.html(node) || '')).filter(Boolean).join('\n');
  }
  if (accessor === 'text') {
    return nodes.map((node: any) => context.$?.(node).text().trim()).filter(Boolean).join('\n');
  }

  const values = nodes.map((node: any) => {
    const attribute = accessor.startsWith('@') ? accessor.slice(1) : accessor;
    return context.$?.(node).attr(attribute) || '';
  }).filter(Boolean);
  return values.join('\n');
}

function readRelativeNodeValue(rule: string, context: RuleContext): unknown {
  if (context.node && context.$) {
    const selection = context.$(context.node);
    if (rule === 'text' || rule === '@text') {
      return selection.text().trim();
    }
    if (rule === 'html' || rule === '@html') {
      return context.$.html(context.node) || '';
    }
    const attribute = rule.startsWith('@') ? rule.slice(1) : rule;
    return selection.attr(attribute) || '';
  }
  if (context.xmlNode) {
    if (rule === 'text' || rule === '@text') {
      return context.xmlNode.textContent?.trim() || '';
    }
    if (rule === 'html' || rule === '@html') {
      return context.xmlNode.toString?.() || '';
    }
    const attribute = rule.startsWith('@') ? rule.slice(1) : rule;
    return context.xmlNode.getAttribute?.(attribute) || '';
  }
  return '';
}

function extractBookInfo(rule: LegadoRuleMap | undefined, context: RuleContext): Record<string, unknown> {
  if (!rule) {
    return {};
  }
  const fields = ['name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'tocUrl'];
  return Object.fromEntries(fields.flatMap(field => {
    const value = stringValue(ruleValue(rule[field], context));
    return value ? [[field, value]] : [];
  }));
}

function contentValueToText(value: unknown, context: RuleContext): string {
  if (isCheerioSelection(value)) {
    return markupText(context.$?.html(value.toArray()[0]) || '');
  }
  if (isXmlNode(value)) {
    return normalizeMarkupText(value.textContent || '');
  }
  if (Array.isArray(value)) {
    return normalizePlainText(value.map(item => contentValueToText(item, context)).filter(Boolean).join('\n'));
  }
  const text = stringValue(value);
  if (!text) {
    return '';
  }
  if (/<(?:br|p|div|section|article|h[1-6])(?:\s|>)/i.test(text)) {
    return markupText(text);
  }
  return normalizePlainText(text);
}

function fallbackPageText(page: string): string {
  if (/<(?:html|body|div|p|article|section)(?:\s|>)/i.test(page)) {
    return markupText(page);
  }
  return normalizePlainText(page);
}

function markupText(value: string): string {
  try {
    const document = parseMarkup(value, '在线书籍内容');
    const root = document.getElementsByTagName('body')[0] || document.documentElement;
    return normalizeMarkupText(root ? extractMarkupText(root) : value);
  } catch {
    return normalizePlainText(value.replace(/<[^>]+>/g, ' '));
  }
}

function ownText(node: any): string {
  const children = node?.children || [];
  const data = node?.data;
  if (node?.type === 'text') {
    return String(data || '').trim();
  }
  return (Array.isArray(children) ? children : [])
    .filter((child: any) => child?.type === 'text')
    .map((child: any) => String(child.data || '').trim())
    .filter(Boolean)
    .join(' ');
}

function parseCssRule(value: string): { selector: string; accessor?: string } {
  const match = value.trim().match(/^(.*?)(?:\s*)@([a-zA-Z][\w-]*)$/s);
  if (!match || !match[1].trim()) {
    return { selector: value.trim() };
  }
  return {
    selector: match[1].trim(),
    accessor: match[2]
  };
}

function splitCleanRule(value: string): ParsedCleanRule | undefined {
  let braceDepth = 0;
  let first = -1;
  let second = -1;
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] === '{' && value[index + 1] === '{') {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (value[index] === '}' && value[index + 1] === '}' && braceDepth > 0) {
      braceDepth -= 1;
      index += 1;
      continue;
    }
    if (braceDepth === 0 && value[index] === '#' && value[index + 1] === '#') {
      if (first < 0) {
        first = index;
      } else {
        second = index;
        break;
      }
      index += 1;
    }
  }
  if (first < 0) {
    return undefined;
  }
  return {
    base: value.slice(0, first).trim(),
    pattern: value.slice(first + 2, second >= 0 ? second : value.length),
    replacement: second >= 0 ? value.slice(second + 2) : ''
  };
}

function applyReplaceRegex(value: string, rule: string): string {
  const parsed = splitCleanRule(rule);
  if (parsed) {
    return applyCleaning(value, parsed.pattern, parsed.replacement);
  }
  try {
    return value.replace(new RegExp(rule, 'g'), '');
  } catch {
    return value;
  }
}

function applyCleaning(value: string, pattern: string, replacement: string): string {
  if (!pattern) {
    return value;
  }
  try {
    const slashPattern = pattern.match(/^\/(.*)\/([dgimsuvy]*)$/s);
    const expression = slashPattern ? new RegExp(slashPattern[1], slashPattern[2].includes('g') ? slashPattern[2] : `${slashPattern[2]}g`) : new RegExp(pattern, 'g');
    return value.replace(expression, replacement);
  } catch {
    return value;
  }
}

function looksLikeUrlOptions(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith(',{')
    || (trimmed.startsWith('{') && /(?:webView|headers|method|charset|body|type)\s*["']?\s*:/i.test(trimmed));
}

function splitOperator(value: string, operator: '||' | '&&'): string[] {
  const parts: string[] = [];
  let start = 0;
  let braces = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{' && value[index + 1] === '{') {
      braces += 1;
      index += 1;
      continue;
    }
    if (character === '}' && value[index + 1] === '}' && braces > 0) {
      braces -= 1;
      index += 1;
      continue;
    }
    if (braces === 0 && value.slice(index, index + 2) === operator) {
      parts.push(value.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }
  if (parts.length === 0) {
    return [value];
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function makeRequestSpec(raw: string, source: LegadoBookSource | undefined, variables: Record<string, unknown>): RequestSpec {
  const comma = topLevelComma(raw);
  const urlPart = comma < 0 ? raw : raw.slice(0, comma);
  const optionsPart = comma < 0 ? '' : raw.slice(comma + 1).trim();
  const interpolatedUrl = interpolateString(urlPart.trim(), variables);
  const url = source
    ? resolveUrl(source.bookSourceUrl, interpolatedUrl)
    : interpolatedUrl;
  const sourceHeaders = parseHeaders(source?.header);
  let options: Record<string, unknown> = {};
  if (optionsPart.startsWith('{')) {
    const parsedOptions = parseJsonLike(interpolateString(optionsPart, variables));
    if (isRecord(parsedOptions)) {
      options = parsedOptions;
    }
  }
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    ...sourceHeaders,
    ...parseHeaders(options.headers)
  };
  const method = String(options.method || 'GET').toUpperCase();
  const bodyValue = options.body;
  let body: string | undefined;
  if (typeof bodyValue === 'string') {
    body = interpolateString(bodyValue, variables);
  } else if (bodyValue !== undefined && bodyValue !== null) {
    body = JSON.stringify(bodyValue);
  }
  if (body && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return {
    url: stripUrlOptions(url),
    method,
    body,
    headers,
    charset: typeof options.charset === 'string' ? options.charset : undefined
  };
}

function parseHeaders(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  }
  if (typeof value !== 'string') {
    return {};
  }
  const parsed = parseJsonLike(value);
  if (isRecord(parsed)) {
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
  }
  return Object.fromEntries(value.split(/\r?\n/).map(line => {
    const index = line.indexOf(':');
    return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : ['', ''];
  }).filter(([key]) => Boolean(key)));
}

function parseJsonLike(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    try {
      const normalized = value
        .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')
        .replace(/'([^']*)'/g, '"$1"');
      return JSON.parse(normalized);
    } catch {
      return undefined;
    }
  }
}

function topLevelComma(value: string): number {
  let braces = 0;
  let brackets = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') braces += 1;
    if (character === '}') braces = Math.max(0, braces - 1);
    if (character === '[') brackets += 1;
    if (character === ']') brackets = Math.max(0, brackets - 1);
    if (character === ',' && braces === 0 && brackets === 0) {
      return index;
    }
  }
  return -1;
}

function interpolateString(value: string, variables: Record<string, unknown>): string {
  return value.replace(/\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => {
    const functionMatch = expression.trim().match(/^(?:java\.)?(encodeURI|encodeURIComponent)\((.*)\)$/s);
    if (functionMatch) {
      const argumentsList = splitFunctionArguments(functionMatch[2]);
      const input = stringValue(resolveVariable(argumentsList[0] || '', variables, undefined));
      const charset = stringLiteral(argumentsList[1]);
      return encodeArgument(input, functionMatch[1], charset);
    }
    return stringValue(resolveVariable(expression.trim(), variables, undefined));
  });
}

function splitFunctionArguments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ',') {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function stringLiteral(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed;
}

function encodeArgument(value: string, functionName: string, charset: string | undefined): string {
  const normalizedCharset = charset?.toLowerCase();
  if (normalizedCharset === 'gbk' || normalizedCharset === 'gb2312' || normalizedCharset === 'gb18030') {
    return [...iconv.encode(value, 'gb18030')]
      .map(byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`)
      .join('');
  }
  return functionName === 'encodeURIComponent' ? encodeURIComponent(value) : encodeURI(value);
}

function resolveVariable(path: string, variables: Record<string, unknown>, json: unknown): unknown {
  const expression = path.trim();
  if (expression === '$') {
    return json;
  }
  if (expression.startsWith('$')) {
    if (json === undefined) {
      return '';
    }
    try {
      const result = JSONPath({ path: expression, json, wrap: true, eval: false }) as unknown[];
      return result.length === 1 ? result[0] : result;
    } catch {
      return '';
    }
  }
  const segments = parseVariablePath(expression);
  if (segments.length === 0) {
    return '';
  }
  const fromVariables = readPath(variables, segments);
  if (fromVariables.found) {
    return fromVariables.value;
  }
  const fromJson = readPath(json, segments);
  return fromJson.found ? fromJson.value : '';
}

function parseVariablePath(expression: string): string[] {
  const value = expression.replace(/^\./, '').trim();
  if (!value) {
    return [];
  }
  const segments: string[] = [];
  const pattern = /([^.[\]]+)|\[(?:"([^"]*)"|'([^']*)'|(-?\d+))\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index !== lastIndex && value.slice(lastIndex, match.index) !== '.') {
      return [];
    }
    segments.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex !== value.length || segments.some(segment => !segment)) {
    return [];
  }
  return segments;
}

function readPath(root: unknown, segments: string[]): { found: boolean; value: unknown } {
  let current = root;
  for (const segment of segments) {
    if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false, value: '' };
    }
  }
  return { found: true, value: current };
}

function isVariableRule(rule: string): boolean {
  return /^(?:key|page|book|chapter|source|result)(?:\.|\[|$)/.test(rule.trim());
}

function regexValue(value: string, rule: string): string {
  try {
    const match = rule.match(/^\/(.*)\/([dgimsuvy]*)$/s);
    const expression = match ? new RegExp(match[1], match[2]) : new RegExp(rule);
    const result = expression.exec(value);
    return result?.[1] ?? result?.[0] ?? '';
  } catch {
    return '';
  }
}

function decodeResponse(buffer: Buffer, charset: string | undefined): string {
  const normalized = (charset || '').trim().toLowerCase().replace(/["']/g, '');
  if (normalized === 'gbk' || normalized === 'gb2312' || normalized === 'gb18030') {
    return iconv.decode(buffer, 'gb18030').replace(/^\uFEFF/, '');
  }
  if (normalized === 'big5') {
    return iconv.decode(buffer, 'big5').replace(/^\uFEFF/, '');
  }
  if (normalized === 'utf-16le' || normalized === 'utf16le') {
    return iconv.decode(buffer, 'utf16-le').replace(/^\uFEFF/, '');
  }
  if (normalized === 'utf-16be' || normalized === 'utf16be') {
    return iconv.decode(buffer, 'utf16-be').replace(/^\uFEFF/, '');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function resolveOptionalUrl(base: string, value: string | undefined): string | undefined {
  return value ? resolveUrl(base, value) : undefined;
}

function resolveUrl(base: string, value: string): string {
  const cleaned = stripUrlOptions(value).trim();
  if (!cleaned) {
    return '';
  }
  if (cleaned.startsWith('//')) {
    try {
      return `${new URL(base).protocol}${cleaned}`;
    } catch {
      return cleaned;
    }
  }
  try {
    return new URL(cleaned, base).toString();
  } catch {
    return cleaned;
  }
}

function stripUrlOptions(value: string): string {
  const comma = topLevelComma(value);
  if (comma < 0) {
    return value.trim();
  }
  const suffix = value.slice(comma + 1).trim();
  return suffix.startsWith('{') || suffix.startsWith('[')
    ? value.slice(0, comma).trim()
    : value.trim();
}

function firstUrl(value: unknown): string {
  if (Array.isArray(value)) {
    return firstUrl(value[0]);
  }
  return stringValue(value);
}

function bookFromReference(reference: OnlineBookReference): Book {
  const chapters: Chapter[] = reference.chapters.map(chapter => ({
    id: chapter.id,
    title: chapter.title,
    content: '',
    source: chapter.source || chapter.url,
    remoteUrl: chapter.url,
    contentLoaded: false
  }));
  return {
    filePath: reference.id,
    title: reference.title,
    format: 'online',
    chapters,
    text: reference.title,
    online: {
      ...reference,
      chapters: reference.chapters.map(chapter => ({ ...chapter })),
      variables: reference.variables ? { ...reference.variables } : undefined
    }
  };
}

function onlineBookId(sourceUrl: string, bookUrl: string): string {
  return `online:${encodeURIComponent(sourceUrl)}:${encodeURIComponent(bookUrl)}`;
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return left === right;
  }
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (isCheerioSelection(value)) {
    return value.toArray().map((node: any) => node.data || node.textContent || '').join('\n').trim();
  }
  if (isXmlNode(value)) {
    return String(value.nodeValue || value.textContent || '').trim();
  }
  if (Array.isArray(value)) {
    return value.map(item => stringValue(item)).filter(Boolean).join('\n').trim();
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value).trim();
}

function hasValue(value: unknown): boolean {
  if (isCheerioSelection(value)) {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return stringValue(value).length > 0;
}

function isCheerioSelection(value: unknown): value is { toArray(): any[]; length: number } {
  return Boolean(value && typeof value === 'object' && typeof (value as { toArray?: unknown }).toArray === 'function');
}

function isCheerioNode(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { type?: unknown; name?: unknown; parent?: unknown; children?: unknown; data?: unknown };
  if (typeof candidate.type !== 'string') {
    return false;
  }
  return candidate.type === 'text'
    ? candidate.data !== undefined
    : candidate.type === 'tag' || candidate.type === 'script' || candidate.type === 'style'
      ? candidate.name !== undefined && (candidate.parent !== undefined || candidate.children !== undefined)
      : candidate.type === 'root' && candidate.children !== undefined;
}

function isXmlNode(value: unknown): value is { nodeValue?: string; textContent?: string } {
  return Boolean(value && typeof value === 'object' && typeof (value as { nodeType?: unknown }).nodeType === 'number');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWithConcurrency<T>(items: T[], limit: number, callback: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      if (current !== undefined) {
        await callback(current);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker()));
}
