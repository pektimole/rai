import { describe, expect, it } from 'vitest';
import { normalizeOcrPage, normalizeWhitespace } from '../src/ocr/recognize';

describe('normalizeWhitespace', () => {
  it('collapses runs of inline whitespace', () => {
    expect(normalizeWhitespace('hello    world')).toBe('hello world');
  });

  it('drops empty lines and trims line edges', () => {
    expect(normalizeWhitespace('  hello  \n\n   \nworld  ')).toBe('hello\nworld');
  });

  it('returns empty string when given only whitespace', () => {
    expect(normalizeWhitespace('   \n\t\n   ')).toBe('');
  });

  it('preserves a single newline between content lines', () => {
    expect(normalizeWhitespace('one\ntwo\nthree')).toBe('one\ntwo\nthree');
  });
});

describe('normalizeOcrPage', () => {
  it('drops words below the confidence floor and averages the rest on a 0..1 scale', () => {
    const page = {
      text: 'hello world',
      words: [
        { text: 'hello', confidence: 90 },
        { text: 'world', confidence: 80 },
        { text: 'noise', confidence: 30 },
      ],
    };
    const result = normalizeOcrPage(page);
    expect(result.raw_word_count).toBe(3);
    expect(result.word_count).toBe(2);
    expect(result.dropped_low_confidence).toBe(1);
    expect(result.ocr_confidence).toBeCloseTo(0.85, 5);
    expect(result.text).toBe('hello world');
  });

  it('reconstructs text from kept words when page.text is missing', () => {
    const page = {
      words: [
        { text: 'recovered', confidence: 70 },
        { text: 'phrase', confidence: 75 },
      ],
    };
    const result = normalizeOcrPage(page);
    expect(result.text).toBe('recovered phrase');
    expect(result.word_count).toBe(2);
  });

  it('returns ocr_confidence=0 and word_count=0 when every word is below threshold', () => {
    const page = {
      text: '',
      words: [
        { text: 'foo', confidence: 10 },
        { text: 'bar', confidence: 20 },
      ],
    };
    const result = normalizeOcrPage(page);
    expect(result.word_count).toBe(0);
    expect(result.dropped_low_confidence).toBe(2);
    expect(result.ocr_confidence).toBe(0);
    expect(result.text).toBe('');
  });

  it('handles a totally empty page object', () => {
    expect(normalizeOcrPage({})).toEqual({
      text: '',
      ocr_confidence: 0,
      word_count: 0,
      dropped_low_confidence: 0,
      raw_word_count: 0,
    });
  });

  it('keeps a word exactly at the 50 threshold', () => {
    const page = {
      text: 'edge case',
      words: [
        { text: 'edge', confidence: 50 },
        { text: 'case', confidence: 49 },
      ],
    };
    const result = normalizeOcrPage(page);
    expect(result.word_count).toBe(1);
    expect(result.dropped_low_confidence).toBe(1);
    expect(result.ocr_confidence).toBeCloseTo(0.5, 5);
  });

  it('normalizes whitespace inside the text passthrough', () => {
    const page = {
      text: '   first    line   \n\n  second   line  ',
      words: [
        { text: 'first', confidence: 90 },
        { text: 'line', confidence: 90 },
        { text: 'second', confidence: 90 },
        { text: 'line', confidence: 90 },
      ],
    };
    const result = normalizeOcrPage(page);
    expect(result.text).toBe('first line\nsecond line');
  });

  it('treats undefined per-word confidence as 0 and drops the word', () => {
    const page = {
      text: 'a',
      words: [
        { text: 'a', confidence: undefined as unknown as number },
        { text: 'b', confidence: 80 },
      ],
    };
    const result = normalizeOcrPage(page);
    expect(result.word_count).toBe(1);
    expect(result.dropped_low_confidence).toBe(1);
    expect(result.ocr_confidence).toBeCloseTo(0.8, 5);
  });
});
