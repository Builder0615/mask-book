export interface ReadableLine {
  rawIndex: number;
  text: string;
}

export interface DisplayLine extends ReadableLine {
  segment: number;
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

/**
 * Split long readable lines into status-bar-sized segments.
 *
 * These segments are only used for manual navigation; the source text keeps
 * its original line structure and is never automatically reflowed.
 */
export function getDisplayLines(content: string, maxLength: number): DisplayLine[] {
  const segmentLength = Math.max(1, Math.floor(maxLength));
  return getReadableLines(content).flatMap(line => {
    const characters = Array.from(line.text);
    const segmentCount = Math.ceil(characters.length / segmentLength);
    return Array.from({ length: segmentCount }, (_, segment) => ({
      rawIndex: line.rawIndex,
      text: characters.slice(segment * segmentLength, (segment + 1) * segmentLength).join(''),
      segment
    }));
  });
}
