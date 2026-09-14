declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    numpages?: number;
    info?: Record<string, unknown>;
  }

  function pdfParse(data: Uint8Array): Promise<PdfParseResult>;

  export = pdfParse;
}
