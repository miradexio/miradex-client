import { describe, it, expect } from 'vitest';
import * as barrel from '../../../../src/wire/server/index.js';

describe('wire/server/index barrel', () => {
  it('exports every expected schema symbol', () => {
    const required = [
      'apiEnvelopeSchema',
      'tolerantEnum',
      'DecimalAmountSchema',
      'IsoTimestampSchema',
      'SwapIdSchema',
      'SwapNumberSchema',
      'TxHashSchema',
      'swapTokenInfoSchema',
      'swapTokenMapSchema',
      'swapPairSchema',
      'swapProviderSchema',
      'swapFeeSchema',
      'swapQuoteSchema',
      'quotesResponseSchema',
      'rateResponseSchema',
      'limitsResponseSchema',
      'providersResponseSchema',
      'liquidityResponseSchema',
      'providerInfoSchema',
      'providerLiquidityDataSchema',
      'providerLiquidityEntrySchema',
      'liquidityEntrySchema',
      'liquidityTotalsSchema',
      'swapStatusSchema',
      'swapVerificationSchema',
      'createSwapBodySchema',
      'createSwapResponseSchema',
      'swapDetailSchema',
      'recentSwapSchema',
      'requiredActionSchema',
      'requiredActionTypeSchema',
      'actionUrgencySchema',
      'swapActionBodySchema',
      'swapActionResponseSchema',
      'actionProtocolDataSchema',
      'preSigsSchema',
      'powChallengeSchema',
      'powPayloadSchema',
      'verifyKeysBodySchema',
      'verifyKeysResponseSchema',
    ];
    for (const name of required) {
      expect(barrel, `missing export: ${name}`).toHaveProperty(name);
    }
  });
});
