/**
 * Tests for get_file's argument schema and the pure line-slice helper behind
 * its start_line/end_line (src/tools/files.ts).
 */
import { describe, it, expect } from 'vitest';
import { GET_FILE_ARGS, sliceFileLines } from '../src/tools/files.js';

const SOURCE = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');

describe('sliceFileLines', () => {
  it('returns the whole file when no bounds are given', () => {
    expect(sliceFileLines(SOURCE)).toEqual({ text: SOURCE, from: 1, to: 5, total: 5 });
  });

  it('slices a 1-based inclusive range', () => {
    expect(sliceFileLines(SOURCE, 2, 4)).toEqual({ text: 'line2\nline3\nline4', from: 2, to: 4, total: 5 });
  });

  it('supports open-ended ranges', () => {
    expect(sliceFileLines(SOURCE, 4)).toEqual({ text: 'line4\nline5', from: 4, to: 5, total: 5 });
    expect(sliceFileLines(SOURCE, undefined, 2)).toEqual({ text: 'line1\nline2', from: 1, to: 2, total: 5 });
  });

  it('clamps end_line to the end of the file', () => {
    expect(sliceFileLines(SOURCE, 5, 100)).toEqual({ text: 'line5', from: 5, to: 5, total: 5 });
  });

  it('returns null when the range selects nothing', () => {
    expect(sliceFileLines(SOURCE, 6)).toBeNull();
    expect(sliceFileLines(SOURCE, 4, 2)).toBeNull();
  });
});

describe('GET_FILE_ARGS', () => {
  it('accepts the canonical numeric bounds', () => {
    expect(GET_FILE_ARGS.parse({ path: 'ViroBox.tsx', start_line: 1, end_line: 40 }))
      .toEqual({ path: 'ViroBox.tsx', start_line: 1, end_line: 40 });
  });

  it('coerces bounds that arrive as strings', () => {
    // What a rewritten alias looks like: argAliases.ts renames startLine to
    // start_line, but the client typed the value off the advertised schema,
    // which never had startLine in it.
    expect(GET_FILE_ARGS.parse({ path: 'ViroBox.tsx', start_line: '1', end_line: '40' }))
      .toEqual({ path: 'ViroBox.tsx', start_line: 1, end_line: 40 });
  });

  it('leaves omitted bounds undefined rather than coercing them to NaN', () => {
    expect(GET_FILE_ARGS.parse({ path: 'ViroBox.tsx' }))
      .toEqual({ path: 'ViroBox.tsx' });
  });

  it('still rejects a non-numeric or out-of-range bound', () => {
    expect(GET_FILE_ARGS.safeParse({ path: 'a.tsx', start_line: 'first' }).success).toBe(false);
    expect(GET_FILE_ARGS.safeParse({ path: 'a.tsx', start_line: '0' }).success).toBe(false);
    expect(GET_FILE_ARGS.safeParse({ path: 'a.tsx', start_line: '1.5' }).success).toBe(false);
  });

  it('teaches the bound names when given the observed offset/limit guess', () => {
    const result = GET_FILE_ARGS.safeParse({ path: 'a.tsx', offset: 10, limit: 50 });
    expect(result.success).toBe(false);
    const message = result.error!.issues[0].message;
    expect(message).toContain('start_line');
    expect(message).toContain('end_line');
    expect(message).toContain('rather than a count');
  });
});
