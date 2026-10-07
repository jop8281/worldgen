import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const amount = z.number().finite().nonnegative();
const instant = z.iso.datetime().transform(v => new Date(v).toISOString());
const windowSchema = z.object({ since: instant, until: instant })
  .refine(w => w.since <= w.until, { message: 'receipt window is reversed' });
const receiptSchema = z.object({
  version: z.literal(1), entryId: z.uuid(), observedAt: instant,
  sandboxId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  inspectionAccount: z.string().regex(/^sha256:[0-9a-f]{12}$/),
  walletId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
  requestedWindow: windowSchema, returnedWindow: windowSchema,
  sandboxType: z.enum(['small', 'default', 'large']), billingMultiplier: amount,
  billableSeconds: amount, listPriceUsd: amount, secondsPerDollar: z.number().finite().positive(),
  running: z.boolean(), priceBasis: z.literal('provider_list_usage'),
}).refine(r => r.requestedWindow.since.endsWith('T00:00:00.000Z') &&
  Date.parse(r.requestedWindow.until) - Date.parse(r.requestedWindow.since) === 86400000,
{ message: 'receipt request must cover one exact UTC day' })
  .refine(r => r.returnedWindow.since >= r.requestedWindow.since && r.returnedWindow.until <= r.requestedWindow.until,
    { message: 'receipt extends outside the requested UTC day' })
  .refine(r => Date.parse(r.returnedWindow.until) <= Date.parse(r.observedAt), { message: 'receipt extends beyond observation time' })
  .refine(r => Math.abs(r.listPriceUsd - r.billableSeconds / r.secondsPerDollar) <= 0.000001,
    { message: 'receipt list price is inconsistent with billable seconds' });

export type BoatReceipt = Readonly<z.output<typeof receiptSchema>>;
export type BoatReceiptInput = Omit<BoatReceipt, 'version' | 'entryId' | 'observedAt' | 'priceBasis'>;
export type CapturedBoatReceipt = BoatReceipt & {
  readonly coverage: 'full_day' | 'partial_day';
  readonly inspectionAccounts: readonly string[];
  readonly walletIds: readonly string[];
  readonly walletStatus: 'organization_metadata' | 'unverified' | 'conflicting';
};

export const boatReceiptsPath = (ledgerFile: string): string => `${ledgerFile}.boat-receipts.jsonl`;

function readReceipts(file: string): { receipts: CapturedBoatReceipt[]; corrupt: number } {
  const entries = new Map<string, BoatReceipt[]>();
  let corrupt = 0;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { corrupt += 1; continue; }
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success) { corrupt += 1; continue; }
    const r = parsed.data;
    const key = JSON.stringify([r.sandboxId, r.requestedWindow.since, r.requestedWindow.until]);
    const group = entries.get(key) ?? [];
    group.push(r);
    entries.set(key, group);
  }
  const receipts: CapturedBoatReceipt[] = [];
  for (const group of entries.values()) {
    const latest = group.reduce((a, b) => b.observedAt >= a.observedAt ? b : a);
    const walletIds = [...new Set(group.flatMap(r => r.walletId === undefined ? [] : [r.walletId]))];
    receipts.push({ ...latest,
      coverage: latest.requestedWindow.since === latest.returnedWindow.since && latest.requestedWindow.until === latest.returnedWindow.until ? 'full_day' : 'partial_day',
      inspectionAccounts: [...new Set(group.map(r => r.inspectionAccount))], walletIds,
      walletStatus: walletIds.length > 1 ? 'conflicting' : walletIds.length === 1 ? 'organization_metadata' : 'unverified',
    });
  }
  return { receipts, corrupt };
}

export function openBoatReceipts(file: string, now: () => number = Date.now) {
  const read = () => readReceipts(file);
  return { path: file, read,
    capture(input: BoatReceiptInput): void {
      const row = receiptSchema.parse({ ...input, version: 1, entryId: randomUUID(), observedAt: new Date(now()).toISOString(), priceBasis: 'provider_list_usage' });
      if (read().corrupt > 0) throw new Error('Boat receipt capture refused: the receipt journal contains corrupt or incomplete records');
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      appendFileSync(file, `${text !== '' && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(row)}\n`, { mode: 0o600, flush: true });
      if (read().corrupt > 0) throw new Error('Boat receipt capture failed: the receipt journal contains corrupt or incomplete records');
    },
  };
}
