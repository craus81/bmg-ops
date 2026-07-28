import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

async function loadSendEmail(env?: { replyTo?: string }) {
  vi.resetModules();
  process.env.RESEND_API_KEY = 'test-key';
  if (env?.replyTo !== undefined) {
    process.env.RESEND_REPLY_TO_EMAIL = env.replyTo;
  } else {
    delete process.env.RESEND_REPLY_TO_EMAIL;
  }
  const mod = await import('./resend');
  return mod.sendEmail;
}

describe('sendEmail', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a single email and returns true', async () => {
    const sendEmail = await loadSendEmail();
    sendMock.mockResolvedValue({ error: null });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>');
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('retries when Resend returns rate_limit_exceeded', async () => {
    const sendEmail = await loadSendEmail();
    sendMock
      .mockResolvedValueOnce({ error: { name: 'rate_limit_exceeded', message: 'Too many requests' } })
      .mockResolvedValueOnce({ error: null });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>');
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting rate-limit retries', async () => {
    const sendEmail = await loadSendEmail();
    sendMock.mockResolvedValue({ error: { name: 'rate_limit_exceeded', message: 'Too many requests' } });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>');
    await vi.runAllTimersAsync();

    expect(await result).toBe(false);
    // 1 initial attempt + 3 retries
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it('returns false on non-rate-limit errors without retrying', async () => {
    const sendEmail = await loadSendEmail();
    sendMock.mockResolvedValue({ error: { name: 'validation_error', message: 'Bad payload' } });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>');
    await vi.runAllTimersAsync();

    expect(await result).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent sends with a gap instead of firing in parallel', async () => {
    const sendEmail = await loadSendEmail();
    const callTimes: number[] = [];
    sendMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      return { error: null };
    });

    const results = Promise.all([
      sendEmail('a@example.com', 'S1', '<p>1</p>'),
      sendEmail('b@example.com', 'S2', '<p>2</p>'),
      sendEmail('c@example.com', 'S3', '<p>3</p>'),
    ]);
    await vi.runAllTimersAsync();

    expect(await results).toEqual([true, true, true]);
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(600);
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(600);
  });

  it('passes an explicit replyTo through to Resend', async () => {
    const sendEmail = await loadSendEmail();
    sendMock.mockResolvedValue({ error: null });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>', undefined, undefined, 'cgeorge@bmgfleet.com');
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ replyTo: 'cgeorge@bmgfleet.com' });
  });

  it('falls back to RESEND_REPLY_TO_EMAIL when no per-send replyTo is given', async () => {
    const sendEmail = await loadSendEmail({ replyTo: 'sales@bmgfleet.com' });
    sendMock.mockResolvedValue({ error: null });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>');
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ replyTo: 'sales@bmgfleet.com' });
  });

  it('per-send replyTo wins over the env default', async () => {
    const sendEmail = await loadSendEmail({ replyTo: 'sales@bmgfleet.com' });
    sendMock.mockResolvedValue({ error: null });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>', undefined, undefined, 'cgeorge@bmgfleet.com');
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ replyTo: 'cgeorge@bmgfleet.com' });
  });

  it('omits replyTo entirely when neither per-send nor env value is set', async () => {
    const sendEmail = await loadSendEmail();
    sendMock.mockResolvedValue({ error: null });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>');
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(sendMock.mock.calls[0][0]).not.toHaveProperty('replyTo');
  });

  it('a blank per-send replyTo falls back to the env default', async () => {
    const sendEmail = await loadSendEmail({ replyTo: 'sales@bmgfleet.com' });
    sendMock.mockResolvedValue({ error: null });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>', undefined, undefined, '  ');
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ replyTo: 'sales@bmgfleet.com' });
  });

  it('a failed send does not block queued sends behind it', async () => {
    const sendEmail = await loadSendEmail();
    sendMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ error: null });

    const first = sendEmail('a@example.com', 'S1', '<p>1</p>');
    const second = sendEmail('b@example.com', 'S2', '<p>2</p>');
    await vi.runAllTimersAsync();

    expect(await first).toBe(false);
    expect(await second).toBe(true);
  });
});
