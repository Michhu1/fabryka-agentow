import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOB_URL_LIFETIME_MS, downloadText } from './clipboard';

describe('downloadText', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('downloads the text and frees the blob URL only after a few seconds', () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:codes', revokeObjectURL: revoke });
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(`${this.download} ${this.getAttribute('href')}`);
    });
    downloadText('kody.txt', 'abc');
    expect(clicks).toEqual(['kody.txt blob:codes']);
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(100);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BLOB_URL_LIFETIME_MS);
    expect(revoke).toHaveBeenCalledWith('blob:codes');
    expect(BLOB_URL_LIFETIME_MS).toBeGreaterThanOrEqual(5_000);
    click.mockRestore();
  });
});
