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

  it('passes bcc through to Resend', async () => {
    const sendEmail = await loadSendEmail();
    sendMock.mockResolvedValue({ error: null });

    const result = sendEmail('a@example.com', 'Subject', '<p>Hi</p>', undefined, undefined, undefined, 'cgeorge@bmgfleet.com');
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ bcc: 'cgeorge@bmgfleet.com' });
  });

  it('omits bcc when not given or blank', async () => {
    const sendEmail = await loadSendEmail();
    sendMock.mockResolvedValue({ error: null });

    const first = sendEmail('a@example.com', 'Subject', '<p>Hi</p>');
    const second = sendEmail('b@example.com', 'Subject', '<p>Hi</p>', undefined, undefined, undefined, '  ');
    await vi.runAllTimersAsync();

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(sendMock.mock.calls[0][0]).not.toHaveProperty('bcc');
    expect(sendMock.mock.calls[1][0]).not.toHaveProperty('bcc');
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

  it('armors the html against QP re-decoding but leaves the text part raw', async () => {
    const sendEmail = await loadSendEmail();
    sendMock.mockResolvedValue({ error: null });

    const html = '<a href="https://app/tracking?vehicle=5fe1ac28-e6ab">Open</a>';
    const result = sendEmail('a@example.com', 'Subject', html);
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      html: '<a href="https://app/tracking?vehicle&#61;5fe1ac28-e6ab">Open</a>',
      text: 'Open',
    });
  });
});

describe('qpProofHtml', () => {
  async function loadQpProofHtml() {
    vi.resetModules();
    const mod = await import('./resend');
    return { qpProofHtml: mod.qpProofHtml, buildNotificationEmail: mod.buildNotificationEmail };
  }

  it('armors = before two hex digits — the UUID query-param case', async () => {
    const { qpProofHtml } = await loadQpProofHtml();
    expect(qpProofHtml('href="/graphics?id=5f5cbf95-7749-4d37-8e32-0deef05aa78f"')).toBe(
      'href="/graphics?id&#61;5f5cbf95-7749-4d37-8e32-0deef05aa78f"'
    );
  });

  it('armors every fragile param in multi-param links', async () => {
    const { qpProofHtml } = await loadQpProofHtml();
    expect(qpProofHtml('href="/upfit?id=ab12cd34&task=ef56aa77"')).toBe(
      'href="/upfit?id&#61;ab12cd34&task&#61;ef56aa77"'
    );
  });

  it('leaves attribute syntax and non-hex-pair params alone', async () => {
    const { qpProofHtml } = await loadQpProofHtml();
    const html = '<div style="color:#fff"><a href="/approve/estimate/tok?via=email&to=cg%40x.com">y</a></div>';
    expect(qpProofHtml(html)).toBe(html);
  });

  it('armors the viewport meta, the other field-observed casualty', async () => {
    const { qpProofHtml } = await loadQpProofHtml();
    expect(qpProofHtml('content="width=device-width,initial-scale=1"')).toBe(
      'content="width&#61;device-width,initial-scale=1"'
    );
  });

  it('leaves no fragile sequence in a full notification email and is idempotent', async () => {
    const { qpProofHtml, buildNotificationEmail } = await loadQpProofHtml();
    const html = buildNotificationEmail(
      'Assigned to Graphics Job',
      "You've been assigned",
      'https://app/graphics?id=5f5cbf95-7749-4d37-8e32-0deef05aa78f',
      'Open in App'
    );
    const armored = qpProofHtml(html);
    expect(armored).not.toMatch(/=[0-9A-Fa-f]{2}/);
    expect(qpProofHtml(armored)).toBe(armored);
  });
});
