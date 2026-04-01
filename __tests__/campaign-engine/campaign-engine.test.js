jest.mock('axios');

const axios = require('axios');
const { runCampaignEngine } = require('../../campaign-engine/campaign-engine');

const baseParsedReceipt = {
  store_name: 'FairPrice',
  purchase_date: '2024-01-15',
  total_amount: 30,
  currency: 'SGD',
  items: [
    { name: 'Milk', price: 3.5, quantity: 2 },
    { name: 'Bread', price: 2.0, quantity: 1 },
  ],
};

function makeCampaign(ruleOverrides = {}) {
  return {
    campaign_post_id: 1,
    title: 'Test Campaign',
    brand_id: 10,
    rules: {
      rules: [
        {
          id: 'rule-1',
          label: 'Base Rule',
          priority: 1,
          when: { all: [{ field: 'receipt.total', op: 'gte', value: '20' }] },
          then: [{ action: 'award_points', mode: 'flat', bonus: 100 }],
          ...ruleOverrides,
        },
      ],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runCampaignEngine — no campaigns', () => {
  test('returns matched=false when no active campaigns', async () => {
    axios.get.mockResolvedValue({ data: { campaigns: [] } });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.matched).toBe(false);
    expect(result.totalSuggestedPoints).toBe(0);
    expect(result.campaignsEvaluated).toBe(0);
    expect(result.suggestions).toHaveLength(0);
  });

  test('still calls saveSuggestion when no campaigns', async () => {
    axios.get.mockResolvedValue({ data: { campaigns: [] } });
    axios.post.mockResolvedValue({ data: {} });

    await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('save-suggestion'),
      expect.objectContaining({ receipt_id: 100 }),
      expect.any(Object)
    );
  });

  test('handles fetchActiveCampaigns network failure gracefully', async () => {
    axios.get.mockRejectedValue(new Error('Network error'));
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.matched).toBe(false);
    expect(result.totalSuggestedPoints).toBe(0);
  });
});

describe('runCampaignEngine — condition evaluation', () => {
  test('matches campaign when gte condition is met', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('campaign/list')) return Promise.resolve({ data: { campaigns: [makeCampaign()] } });
      return Promise.resolve({ data: { redemption_limit: 0, redemption_count: 0 } });
    });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.matched).toBe(true);
    expect(result.suggestions[0].matched).toBe(true);
    expect(result.totalSuggestedPoints).toBe(100);
  });

  test('does not match when gte condition is not met (total too low)', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('campaign/list')) return Promise.resolve({ data: { campaigns: [makeCampaign()] } });
      return Promise.resolve({ data: { redemption_limit: 0, redemption_count: 0 } });
    });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({
      profileId: 1,
      receiptId: 100,
      parsedReceipt: { ...baseParsedReceipt, total_amount: 10 },
    });
    expect(result.suggestions[0].matched).toBe(false);
    expect(result.totalSuggestedPoints).toBe(0);
  });

  test('matches with any condition (one of multiple conditions true)', async () => {
    const campaign = makeCampaign({
      when: {
        any: [
          { field: 'receipt.total', op: 'gte', value: '100' }, // false
          { field: 'receipt.store_name', op: 'contains', value: 'fairprice' }, // true
        ],
      },
    });
    axios.get.mockImplementation((url) => {
      if (url.includes('campaign/list')) return Promise.resolve({ data: { campaigns: [campaign] } });
      return Promise.resolve({ data: { redemption_limit: 0, redemption_count: 0 } });
    });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.suggestions[0].matched).toBe(true);
  });

  test('fails all condition when all conditions not met', async () => {
    const campaign = makeCampaign({
      when: {
        all: [
          { field: 'receipt.total', op: 'gte', value: '100' }, // false
          { field: 'receipt.store_name', op: 'eq', value: 'grab' }, // false
        ],
      },
    });
    axios.get.mockImplementation((url) => {
      if (url.includes('campaign/list')) return Promise.resolve({ data: { campaigns: [campaign] } });
      return Promise.resolve({ data: {} });
    });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.suggestions[0].matched).toBe(false);
  });

  test('null when condition matches any receipt', async () => {
    const campaign = makeCampaign({ when: null });
    axios.get.mockImplementation((url) => {
      if (url.includes('campaign/list')) return Promise.resolve({ data: { campaigns: [campaign] } });
      return Promise.resolve({ data: {} });
    });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.suggestions[0].matched).toBe(true);
  });

  test('matches against receipt items using contains_any', async () => {
    const campaign = makeCampaign({
      when: { all: [{ field: 'receipt.items.name', op: 'contains_any', value: ['milk', 'juice'] }] },
    });
    axios.get.mockImplementation((url) => {
      if (url.includes('campaign/list')) return Promise.resolve({ data: { campaigns: [campaign] } });
      return Promise.resolve({ data: {} });
    });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.suggestions[0].matched).toBe(true);
  });
});

describe('runCampaignEngine — points calculation', () => {
  function setupCampaign(thenActions) {
    const campaign = makeCampaign({ when: null, then: thenActions });
    axios.get.mockImplementation((url) => {
      if (url.includes('campaign/list')) return Promise.resolve({ data: { campaigns: [campaign] } });
      return Promise.resolve({ data: { redemption_limit: 0, redemption_count: 0 } });
    });
    axios.post.mockResolvedValue({ data: {} });
  }

  test('flat mode returns fixed bonus points', async () => {
    setupCampaign([{ action: 'award_points', mode: 'flat', bonus: 200 }]);
    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.totalSuggestedPoints).toBe(200);
  });

  test('per_dollar mode: floor(total * rate * multiplier)', async () => {
    setupCampaign([{ action: 'award_points', mode: 'per_dollar', rate: 1, multiplier: 2 }]);
    // 30 * 1 * 2 = 60
    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.totalSuggestedPoints).toBe(60);
  });

  test('per_dollar mode uses floor rounding by default', async () => {
    setupCampaign([{ action: 'award_points', mode: 'per_dollar', rate: 0.3 }]);
    // 30 * 0.3 = 9.0 → floor = 9
    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.totalSuggestedPoints).toBe(9);
  });

  test('tiered mode picks highest qualifying tier', async () => {
    setupCampaign([{
      action: 'award_points',
      mode: 'tiered',
      tiers: [
        { min_spend: 50, points: 500 },
        { min_spend: 20, points: 200 }, // total=30, this tier matches
        { min_spend: 10, points: 100 },
      ],
    }]);
    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.totalSuggestedPoints).toBe(200);
  });

  test('tiered mode returns 0 when spend below all tiers', async () => {
    setupCampaign([{
      action: 'award_points',
      mode: 'tiered',
      tiers: [{ min_spend: 50, points: 500 }, { min_spend: 40, points: 300 }],
    }]);
    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.totalSuggestedPoints).toBe(0);
  });

  test('flat_per_match mode multiplies bonus by matched item count', async () => {
    setupCampaign([{
      action: 'award_points',
      mode: 'flat_per_match',
      bonus: 50,
      match_keywords: ['milk'],
    }]);
    // 1 item matches "milk" → 50 * 1 = 50
    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.totalSuggestedPoints).toBe(50);
  });

  test('non award_points action is ignored', async () => {
    setupCampaign([{ action: 'send_notification', message: 'Thanks!' }]);
    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.totalSuggestedPoints).toBe(0);
  });
});

describe('runCampaignEngine — campaign with no rules', () => {
  test('includes campaign as unmatched with 0 points when no rules defined', async () => {
    const noRulesCampaign = {
      campaign_post_id: 2,
      title: 'No Rules Campaign',
      brand_id: 10,
      rules: { rules: [] },
    };
    axios.get.mockResolvedValue({ data: { campaigns: [noRulesCampaign] } });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.suggestions[0].matched).toBe(false);
    expect(result.suggestions[0].suggested_points).toBe(0);
    expect(result.suggestions[0].rule_label).toBe('No rules defined');
  });
});

describe('runCampaignEngine — multiple campaigns', () => {
  test('evaluates all campaigns and aggregates matched points', async () => {
    const campaign1 = makeCampaign({ when: null, then: [{ action: 'award_points', mode: 'flat', bonus: 100 }] });
    const campaign2 = {
      campaign_post_id: 2,
      title: 'Campaign 2',
      brand_id: 11,
      rules: {
        rules: [{
          id: 'rule-2',
          when: null,
          then: [{ action: 'award_points', mode: 'flat', bonus: 50 }],
        }],
      },
    };
    axios.get.mockImplementation((url) => {
      if (url.includes('campaign/list')) return Promise.resolve({ data: { campaigns: [campaign1, campaign2] } });
      return Promise.resolve({ data: {} });
    });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    expect(result.campaignsEvaluated).toBe(2);
    expect(result.totalSuggestedPoints).toBe(150);
  });
});

describe('runCampaignEngine — rule priority', () => {
  test('evaluates higher priority rules first', async () => {
    const campaign = {
      campaign_post_id: 1,
      title: 'Priority Campaign',
      brand_id: 10,
      rules: {
        rules: [
          { id: 'low', label: 'Low Priority', priority: 1, when: null, then: [{ action: 'award_points', mode: 'flat', bonus: 10 }] },
          { id: 'high', label: 'High Priority', priority: 10, when: null, then: [{ action: 'award_points', mode: 'flat', bonus: 100 }] },
        ],
      },
    };
    axios.get.mockImplementation((url) => {
      if (url.includes('campaign/list')) return Promise.resolve({ data: { campaigns: [campaign] } });
      return Promise.resolve({ data: {} });
    });
    axios.post.mockResolvedValue({ data: {} });

    const result = await runCampaignEngine({ profileId: 1, receiptId: 100, parsedReceipt: baseParsedReceipt });
    // Both rules match, both contribute to total
    expect(result.totalSuggestedPoints).toBe(110);
    // High priority rule should appear first in suggestions
    expect(result.suggestions[0].rule_id).toBe('high');
  });
});
