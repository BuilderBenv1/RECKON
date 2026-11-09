import { createHash, randomUUID } from 'node:crypto';

/**
 * Request ids that are the same every time the same operation is attempted in the same run.
 * Two requests racing on one run (a webhook and a poll, say) then send Airwallex the same
 * request_id for the same payment, and Airwallex refuses the second. A genuinely new operation
 * (a replacement payment, a second conversion) has a different key, so it gets a new id.
 */
export function requestIds(seed: string | undefined): (key: string) => string {
  if (!seed) return () => randomUUID();
  return (key) => {
    const h = createHash('sha256').update(`${seed}|${key}`).digest('hex');
    // Format as an RFC 4122 UUID (version 5 style bits) so Airwallex accepts it.
    const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}
