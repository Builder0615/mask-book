export interface ReadableLine {
  rawIndex: number;
  text: string;
}

/**
 * Return only lines that contain visible text while preserving their original
 * indexes for backwards-compatible reading positions.
 */
export function getReadableLines(content: string): ReadableLine[] {
  return content.split('\n').reduce<ReadableLine[]>((lines, line, rawIndex) => {
    const text = line.trim();
    if (text) {
      lines.push({ rawIndex, text });
    }
    return lines;
  }, []);
}
