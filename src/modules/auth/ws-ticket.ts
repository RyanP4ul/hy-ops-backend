import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import { ws_tickets } from "../../db/schema/ws-ticket";

const hashTicket = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

export async function issueWsTicket(claims: Record<string, unknown>) {
  const ticket = randomBytes(32).toString("base64url");
  // Use the database clock for issuance and redemption across backend instances.
  await db.delete(ws_tickets).where(lte(ws_tickets.expires_at, sql`now()`));
  await db.insert(ws_tickets).values({
    ticket_hash: hashTicket(ticket),
    claims,
    expires_at: sql`now() + interval '30 seconds'`,
  });
  return ticket;
}

export async function consumeWsTicket(ticket: string): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  // DELETE ... RETURNING makes redemption single use, including concurrent upgrades.
  const [row] = await db.delete(ws_tickets).where(and(
    eq(ws_tickets.ticket_hash, hashTicket(ticket)),
    gt(ws_tickets.expires_at, sql`now()`),
  )).returning({ claims: ws_tickets.claims });
  return row?.claims ?? null;
}
