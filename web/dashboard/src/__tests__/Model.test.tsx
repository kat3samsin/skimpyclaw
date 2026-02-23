import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { Model } from '../pages/Model.js';

vi.mock('../api/client.js', () => ({
  getModel: vi.fn(),
  setModel: vi.fn(),
}));

import { getModel, setModel } from '../api/client.js';

describe('Model page', () => {
  const showToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getModel).mockResolvedValue({
      current: 'anthropic/claude-sonnet-4-5',
      aliases: {
        'claude-fast': 'anthropic/claude-haiku-4-5',
        'codex5.3': 'codex/gpt-5.3-codex',
      },
      agents: { main: 'anthropic/claude-sonnet-4-5' },
    });
  });

  it('renders alias chips from API response', async () => {
    const { getByText } = render(<Model showToast={showToast} />);
    await waitFor(() => {
      expect(getByText('claude-fast')).toBeTruthy();
      expect(getByText('codex5.3')).toBeTruthy();
    });
  });

  it('sets input when alias chip is clicked', async () => {
    const { getByText, getByPlaceholderText } = render(<Model showToast={showToast} />);
    await waitFor(() => expect(getByText('claude-fast')).toBeTruthy());
    fireEvent.click(getByText('claude-fast'));
    const input = getByPlaceholderText('Model ID or alias') as HTMLInputElement;
    expect(input.value).toBe('claude-fast');
  });

  it('submits selected alias and updates active model using resolved response', async () => {
    vi.mocked(setModel).mockResolvedValue({ model: 'anthropic/claude-haiku-4-5' });
    const { getByText, getByPlaceholderText } = render(<Model showToast={showToast} />);
    await waitFor(() => expect(getByText('claude-fast')).toBeTruthy());

    fireEvent.click(getByText('claude-fast'));
    fireEvent.click(getByText('Switch Model'));

    await waitFor(() => {
      expect(setModel).toHaveBeenCalledWith('claude-fast');
      expect(showToast).toHaveBeenCalledWith('Model updated', 'success');
    });

    const input = getByPlaceholderText('Model ID or alias') as HTMLInputElement;
    expect(input.value).toBe('anthropic/claude-haiku-4-5');
    expect(getByText('anthropic/claude-haiku-4-5')).toBeTruthy();
  });

  it('does not submit invalid alias-like input', async () => {
    const { getByText, getByPlaceholderText } = render(<Model showToast={showToast} />);
    await waitFor(() => expect(getByText('claude-fast')).toBeTruthy());

    const input = getByPlaceholderText('Model ID or alias') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'unknown_alias' } });
    fireEvent.click(getByText('Switch Model'));

    expect(setModel).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Unknown model alias: "unknown_alias"', 'error');
  });

  it('shows invalid selection error for malformed provider/model input', async () => {
    const { getByText, getByPlaceholderText } = render(<Model showToast={showToast} />);
    await waitFor(() => expect(getByText('claude-fast')).toBeTruthy());

    const input = getByPlaceholderText('Model ID or alias') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'anthropic/' } });
    fireEvent.click(getByText('Switch Model'));

    expect(setModel).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'Invalid model selection: "anthropic/". Use alias, provider/model, or model-id.',
      'error'
    );
  });
});
