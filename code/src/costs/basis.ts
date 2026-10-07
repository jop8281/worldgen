import { z } from 'zod';

export const costBasisSchema = z.enum(['sdk_configured_rates', 'cli_reported_cost', 'cli_configured_rates']);
export type CostBasis = z.infer<typeof costBasisSchema>;
